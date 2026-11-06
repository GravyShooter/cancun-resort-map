// Hail Mary init script — injected into every page frame BEFORE any page
// script runs (Playwright add_init_script). It does ONE thing:
//
//   Hooks RTCPeerConnection so every remote (incoming) audio track is
//   captured: it is metered (RMS level), recorded (MediaRecorder chunks
//   forwarded to Node for STT), and kept in a combined remote stream.
//
// The MICROPHONE is NOT faked here. TextNow gets Chromium's real default
// mic, which on the GitHub Actions runner is the PulseAudio virtual_mic
// (a remap source of the tts_sink.monitor — see the workflow YAML).
// TTS audio is played into tts_sink with paplay from Node, so it flows
// through the real mic into the call. This is the Vexa pattern
// (github.com/Vexa-ai/vexa, issue #120): the old Web Audio fake mic
// (OscillatorNode -> MediaStreamDestination) does NOT render in headless
// Chromium on the runner — it is always silent (micLevel 0) — so it was
// removed entirely. Do NOT re-add a Web Audio fake mic or a
// getUserMedia override. Chromium must be launched WITHOUT
// --use-fake-device-for-media-stream (bypasses PulseAudio) and WITHOUT
// --use-file-for-fake-audio-capture (forces silence as mic input).
//
// Nothing here places a call, logs in anywhere, or talks to any server.
// It only captures incoming audio inside the browser.
//
// Public surface: window.__hailmary
//   .remoteTracks         - captured remote MediaStreamTracks
//   .remoteStream         - MediaStream of all captured remote tracks
//   .remoteChunks         - [{size, at}] MediaRecorder chunks of remote audio
//   .remoteLevel()        - max RMS level across remote analysers (0..~1)
//   .events               - log of hook events [{at, kind, detail}]
//   .peerConnections      - RTCPeerConnection instances created after inject

(function () {
  'use strict';
  if (window.__hailmary) return; // installed already (re-navigation guard)

  var log = [];
  function event(kind, detail) {
    log.push({ at: Date.now(), kind: kind, detail: detail || '' });
    if (log.length > 500) log.shift();
  }

  // ---- AudioContext (remote metering only — never the mic) ----
  // The remote analysers need an AudioContext. It is created lazily and
  // resumed; it processes the remote tracks only. The mic does not pass
  // through this graph.
  var audioCtx = null;
  function ensureCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('no AudioContext in this browser');
      audioCtx = new AC();
      event('audioctx-created', 'sampleRate=' + audioCtx.sampleRate + ' state=' + audioCtx.state);
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () { /* autoplay policy; retried on use */ });
    }
    return audioCtx;
  }

  // ---- Remote (incoming) audio capture ----
  var remoteTracks = [];
  var remoteStream = new MediaStream();
  var remoteAnalysers = [];
  var remoteRecorders = [];
  var remoteChunks = []; // {size, at}

  function remoteLevel() {
    var max = 0;
    var buf = new Float32Array(2048);
    for (var i = 0; i < remoteAnalysers.length; i++) {
      remoteAnalysers[i].getFloatTimeDomainData(buf);
      var sum = 0;
      for (var j = 0; j < buf.length; j++) sum += buf[j] * buf[j];
      var rms = Math.sqrt(sum / buf.length);
      if (rms > max) max = rms;
    }
    return max;
  }

  function captureRemoteTrack(track, pc) {
    remoteTracks.push(track);
    try { remoteStream.addTrack(track); } catch (e) { /* already added */ }
    event('remote-track', 'kind=' + track.kind + ' id=' + track.id + ' state=' + track.readyState);
    try {
      var ctx = ensureCtx();
      var src = ctx.createMediaStreamSource(new MediaStream([track]));
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      remoteAnalysers.push(analyser);
    } catch (e) {
      event('analyser-failed', String(e));
    }
    try {
      if (typeof MediaRecorder !== 'undefined') {
        var mime = '';
        var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];
        for (var i = 0; i < candidates.length; i++) {
          if (!candidates[i] || MediaRecorder.isTypeSupported(candidates[i])) {
            mime = candidates[i];
            break;
          }
        }
        var rec = mime ? new MediaRecorder(new MediaStream([track]), { mimeType: mime })
                       : new MediaRecorder(new MediaStream([track]));
        rec.ondataavailable = function (ev) {
          if (ev.data && ev.data.size) {
            remoteChunks.push({ size: ev.data.size, at: Date.now() });
            // Forward to Node (Playwright exposeFunction) when present.
            if (typeof window.__sendAudioChunk === 'function') {
              var reader = new FileReader();
              reader.onloadend = function () {
                try { window.__sendAudioChunk(reader.result); } catch (e) { /* drop chunk */ }
              };
              reader.readAsDataURL(ev.data);
            }
          }
        };
        rec.start(250); // 250 ms slices
        remoteRecorders.push(rec);
        event('recorder-started', 'mime=' + (mime || '(default)'));
      }
    } catch (e) {
      event('recorder-failed', String(e));
    }
  }

  // ---- RTCPeerConnection hook ----
  var peerConnections = [];
  if (typeof window.RTCPeerConnection === 'function') {
    var OrigPC = window.RTCPeerConnection;
    function PatchedPC() {
      var args = Array.prototype.slice.call(arguments);
      var pc = new (Function.prototype.bind.apply(OrigPC, [null].concat(args)))();
      peerConnections.push(pc);
      event('pc-created', 'total=' + peerConnections.length);
      // Our own 'track' listener runs alongside the page's listeners and
      // captures every incoming remote track, however the page listens.
      pc.addEventListener('track', function (ev) {
        var track = ev.track || (ev.streams && ev.streams[0] && ev.streams[0].getAudioTracks()[0]);
        if (track) captureRemoteTrack(track, pc);
        else if (ev.streams) {
          ev.streams.forEach(function (s) {
            s.getAudioTracks().forEach(function (t) { captureRemoteTrack(t, pc); });
          });
        }
      });
      return pc;
    }
    PatchedPC.prototype = OrigPC.prototype;
    Object.setPrototypeOf(PatchedPC, OrigPC);
    Object.getOwnPropertyNames(OrigPC).forEach(function (k) {
      if (k !== 'prototype' && k !== 'length' && k !== 'name') {
        try { PatchedPC[k] = OrigPC[k]; } catch (e) { /* non-writable */ }
      }
    });
    window.RTCPeerConnection = PatchedPC;
    event('pc-hooked', 'RTCPeerConnection constructor wrapped');
  } else {
    event('pc-missing', 'no RTCPeerConnection in this context');
  }

  window.__hailmary = {
    remoteTracks: remoteTracks,
    remoteStream: remoteStream,
    remoteChunks: remoteChunks,
    remoteLevel: remoteLevel,
    events: log,
    peerConnections: peerConnections,
  };
})();
