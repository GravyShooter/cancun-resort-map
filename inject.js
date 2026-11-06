// Hail Mary init script — injected into every page frame BEFORE any page
// script runs (Playwright add_init_script). It does two things:
//
//  (1) Overrides navigator.mediaDevices.getUserMedia so that when the web
//      app (TextNow) asks for the microphone, it receives a GENERATED audio
//      MediaStream (our TTS audio) instead of a real microphone. This VM
//      has no mic or speaker; all audio is software.
//  (2) Hooks RTCPeerConnection so every remote (incoming) audio track is
//      captured: it is metered (RMS level), recorded (MediaRecorder chunks
//      forwarded to Node for STT), and kept in a combined remote stream.
//
// Nothing here places a call, logs in anywhere, or talks to any server.
// It only re-routes audio inside the browser.
//
// Public surface: window.__hailmary
//   .micStream            - the fake-mic MediaStream (1 live audio track)
//   .remoteTracks         - captured remote MediaStreamTracks
//   .remoteStream         - MediaStream of all captured remote tracks
//   .remoteChunks         - [{size, at}] MediaRecorder chunks of remote audio
//   .remoteLevel()        - max RMS level across remote analysers (0..~1)
//   .tone(freq, seconds)  - play a sine tone into the fake mic (test/TTS stub)
//   .sayBuffer(arrayBuf)  - decode + play audio into the fake mic (real TTS)
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

  // ---- Fake microphone: a Web Audio graph whose output IS the mic ----
  // Signal flow: sources (tone / TTS) -> micBus (GainNode) -> destination
  // (MediaStreamDestination = the mic stream). The analyser taps micBus,
  // because a MediaStreamDestination is a sink with no outputs and cannot
  // be connected to an analyser.
  var audioCtx = null;
  var destination = null; // MediaStreamDestination node
  var micStream = null;
  var micBus = null;

  function ensureCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('no AudioContext in this browser');
      audioCtx = new AC();
      destination = audioCtx.createMediaStreamDestination();
      micBus = audioCtx.createGain();
      micBus.connect(destination);
      micStream = destination.stream;
      event('audioctx-created', 'sampleRate=' + audioCtx.sampleRate + ' state=' + audioCtx.state);
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () { /* autoplay policy; retried on use */ });
    }
    return audioCtx;
  }

  function mic() {
    ensureCtx();
    return micStream;
  }

  // Play a sine tone into the fake mic (used by dry-run tests and as a
  // TTS stand-in). Returns the scheduled duration.
  function tone(freq, seconds) {
    var ctx = ensureCtx();
    freq = freq || 880;
    seconds = seconds || 1;
    var t0 = ctx.currentTime + 0.05;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0, t0);
    gain.gain.linearRampToValueAtTime(0.5, t0 + 0.02);
    gain.gain.setValueAtTime(0.5, t0 + seconds - 0.05);
    gain.gain.linearRampToValueAtTime(0.0001, t0 + seconds);
    osc.connect(gain);
    gain.connect(micBus);
    osc.start(t0);
    osc.stop(t0 + seconds + 0.05);
    event('tone', freq + 'Hz ' + seconds + 's');
    return seconds;
  }

  // Decode audio bytes (mp3/wav/ogg from a TTS provider) and play them
  // into the fake mic. Resolves with the clip duration in seconds.
  async function sayBuffer(arrayBuffer) {
    var ctx = ensureCtx();
    var buf = await ctx.decodeAudioData(arrayBuffer);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(micBus);
    src.start();
    event('sayBuffer', 'duration=' + buf.duration.toFixed(2) + 's channels=' + buf.numberOfChannels);
    return buf.duration;
  }

  // ---- Remote (incoming) audio capture ----
  var remoteTracks = [];
  var remoteStream = new MediaStream();
  var remoteAnalysers = [];
  var remoteRecorders = [];
  var remoteChunks = []; // {size, at}

  // Meter the FAKE MIC stream itself (what the peer will hear). Used by
  // dry-run tests to prove TTS audio is actually flowing into the mic.
  var micAnalyser = null;
  function micLevel() {
    try {
      var ctx = ensureCtx();
      if (!micAnalyser) {
        micAnalyser = ctx.createAnalyser();
        micAnalyser.fftSize = 2048;
        // Tap micBus: the same signal that feeds the mic stream.
        micBus.connect(micAnalyser);
      }
      var buf = new Float32Array(2048);
      micAnalyser.getFloatTimeDomainData(buf);
      var sum = 0;
      for (var j = 0; j < buf.length; j++) sum += buf[j] * buf[j];
      return Math.sqrt(sum / buf.length);
    } catch (e) {
      return 0;
    }
  }

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

  // ---- (1) getUserMedia override ----
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    var origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function (constraints) {
      var wantAudio = !!(constraints && constraints.audio);
      if (wantAudio) {
        event('gum-intercepted', JSON.stringify(constraints));
        return Promise.resolve(mic());
      }
      // Video-only or no audio: pass through to the real implementation.
      return origGUM(constraints);
    };
    event('gum-overridden', 'audio requests now return the fake mic');
  } else {
    event('gum-missing', 'navigator.mediaDevices.getUserMedia not present');
  }

  // Legacy getUserMedia entry points, same treatment.
  ['getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia'].forEach(function (name) {
    if (typeof navigator[name] === 'function') {
      navigator[name] = function (constraints, success, error) {
        if (constraints && constraints.audio) {
          event('legacy-gum-intercepted', name);
          success(mic());
          return;
        }
        error(new Error('video-only getUserMedia not supported by HailMary'));
      };
    }
  });

  // Advertise a fake microphone so device pickers see a mic.
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    var origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async function () {
      var devices = [];
      try { devices = await origEnum(); } catch (e) { /* ignore */ }
      devices.push({
        deviceId: 'hailmary-virtual-mic',
        kind: 'audioinput',
        label: 'HailMary Virtual Mic',
        groupId: 'hailmary',
        toJSON: function () {
          return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId };
        },
      });
      return devices;
    };
  }

  // ---- (2) RTCPeerConnection hook ----
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
    micStream: null, // set below (getter keeps it live)
    get mic() { return mic(); },
    remoteTracks: remoteTracks,
    remoteStream: remoteStream,
    remoteChunks: remoteChunks,
    remoteLevel: remoteLevel,
    micLevel: micLevel,
    tone: tone,
    sayBuffer: sayBuffer,
    events: log,
    peerConnections: peerConnections,
    ensureCtx: ensureCtx,
  };
  // Keep .micStream in sync with the lazy AudioContext.
  Object.defineProperty(window.__hailmary, 'micStream', {
    get: function () { return micStream; },
    enumerable: true,
  });
})();
