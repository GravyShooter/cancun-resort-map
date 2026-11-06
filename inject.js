// Hail Mary init script — injected into every page frame BEFORE any page
// script runs (Playwright add_init_script). It does ONE thing:
//
//   Hooks RTCPeerConnection so every remote (incoming) audio track is
//   captured: it is metered (RMS level), captured as raw PCM through
//   the Web Audio API (PRIMARY — see below), recorded (MediaRecorder
//   chunks forwarded to Node for STT, FALLBACK), and kept in a combined
//   remote stream.
//
// RECEIVE CAPTURE — why Web Audio PCM is primary:
//   MediaRecorder can be BLIND in headless Chromium: it yields 0 chunks
//   even when RTP flows and the remote track is live/unmuted/enabled,
//   because the receive pipeline stalls when nothing pulls decoded
//   audio. A ScriptProcessorNode FORCES the audio graph to render (its
//   onaudioprocess must be called for every quantum), which pulls audio
//   from the MediaStreamSource. Connecting it to the destination through
//   a zero-gain node (so nothing is heard) keeps the graph alive. Raw
//   Float32 samples are buffered and forwarded to Node in ~500ms batches
//   via window.__sendAudioPcm (base64 Float32 + sample rate). This is
//   the remote (incoming) track only — it never touches the mic.
//   ScriptProcessorNode is deprecated but still present in Chromium and
//   is the most reliable pull-mechanism in headless; if it is ever
//   removed, AudioWorkletNode is the replacement.
//
// The MICROPHONE is NOT faked here. TextNow gets Chromium's real default
// mic, which on the GitHub Actions runner is the PulseAudio pipe-source
// virtmic (module-pipe-source, fed live by the FIFO /tmp/virtmic — see
// the workflow YAML). Node writes raw s16le 48kHz mono PCM (Chatty Porch
// audio, decoded from MP3) into the FIFO, so it flows through the real
// mic into the call. This replaces the Vexa remap-source approach, which
// failed because Chromium refuses a .monitor as a mic input. The old Web
// Audio fake mic (OscillatorNode -> MediaStreamDestination) does NOT
// render in headless Chromium on the runner — it is always silent
// (micLevel 0) — so it was removed entirely. Do NOT re-add a Web Audio
// fake mic or a getUserMedia override. Chromium must be launched WITHOUT
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
//   .pcmRms()             - RMS of buffered Web Audio PCM samples (0..~1)
//   .pcmCount()           - number of buffered Web Audio PCM samples
//   .pcmSampleRate()      - sample rate of the Web Audio PCM (Hz)
//   .flushPcm(force)      - forward buffered PCM to Node now (via __sendAudioPcm)
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

  // ---- Web Audio PCM capture state (PRIMARY receive path) ----
  // Raw Float32 samples of the remote track(s), mono, at
  // pcmSampleRate. Forwarded to Node in ~500ms batches via
  // window.__sendAudioPcm when it is exposed; otherwise buffered
  // (bounded) so window.__hailmary.pcmRms() can be read in-page.
  var pcmBuf = []; // Float32 samples, mono
  var pcmSampleRate = 0;
  var pcmFlushAt = 0;
  var pcmNodes = [];

  function pcmRms() {
    if (!pcmBuf.length) return 0;
    var sum = 0;
    for (var i = 0; i < pcmBuf.length; i++) sum += pcmBuf[i] * pcmBuf[i];
    return Math.sqrt(sum / pcmBuf.length);
  }
  function u8ToB64(u8) {
    var s = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }
  function flushPcm(force) {
    if (!pcmBuf.length) return;
    if (!force && Date.now() - pcmFlushAt < 500) return;
    pcmFlushAt = Date.now();
    if (typeof window.__sendAudioPcm !== 'function') return;
    var chunk = new Float32Array(pcmBuf);
    pcmBuf = [];
    try {
      window.__sendAudioPcm(u8ToB64(new Uint8Array(chunk.buffer)), pcmSampleRate);
    } catch (e) { /* drop batch */ }
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
    // ---- Web Audio PCM capture (PRIMARY receive path) ----
    // MediaRecorder can be blind in headless Chromium (0 chunks even
    // when RTP flows). A ScriptProcessorNode FORCES the audio graph to
    // render — its onaudioprocess must be called for every quantum —
    // which pulls audio from the MediaStreamSource. Connecting it to
    // the destination through a zero-gain node (nothing heard) keeps
    // the graph alive. Raw Float32 samples are buffered and forwarded
    // to Node in ~500ms batches via window.__sendAudioPcm.
    try {
      var pctx = ensureCtx();
      var psrc = pctx.createMediaStreamSource(new MediaStream([track]));
      var proc = pctx.createScriptProcessor(4096, 1, 1);
      var mute = pctx.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = function (ev) {
        var input = ev.inputBuffer.getChannelData(0);
        for (var i = 0; i < input.length; i++) pcmBuf.push(input[i]);
        // Bound the buffer (~10s at 48kHz) when Node is not listening;
        // keep the newest samples so in-page RMS stays meaningful.
        if (pcmBuf.length > 480000) pcmBuf.splice(0, pcmBuf.length - 240000);
        flushPcm(false);
      };
      psrc.connect(proc);
      proc.connect(mute);
      mute.connect(pctx.destination);
      pcmSampleRate = pctx.sampleRate;
      pcmNodes.push({ proc: proc, gain: mute });
      event('webaudio-pcm-started', 'sampleRate=' + pctx.sampleRate);
    } catch (e) {
      event('webaudio-pcm-failed', String(e));
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
    pcmRms: pcmRms,
    pcmCount: function () { return pcmBuf.length; },
    pcmSampleRate: function () { return pcmSampleRate; },
    flushPcm: flushPcm,
    events: log,
    peerConnections: peerConnections,
  };
})();
