// spud-virtualmic.js — a self-contained virtual microphone for the
// room-service caller.
//
// Purpose: let a WebRTC calling page (PopTox / FreeCallMe) hear a
// pre-recorded order voice message as if it were the phone's microphone,
// with NO speakerphone and NO real mic audio.
//
// How it works:
//  1. The moment this script runs it replaces every getUserMedia entry
//     point (navigator.mediaDevices.getUserMedia, navigator.getUserMedia,
//     webkit/moz variants) with a function that returns a synthetic
//     MediaStream. The stream comes from an AudioContext +
//     MediaStreamDestination, so anything the page records from "the mic"
//     is exactly what this script plays into it — never the real mic.
//  2. The order voice message is a 48 kHz mono WAV (the native WebRTC /
//     AudioContext rate, so there is no resampling). It is fetched from
//     the app's loopback server and decoded with decodeAudioData, then
//     played through a BufferSource connected to the destination.
//  3. Incoming (remote) audio is metered through an AnalyserNode into a
//     zero-gain node: the app can see when the other side speaks, but
//     nothing is ever played aloud.
//
// This file is intentionally separate from the older dialer automation
// script. Inject it as early as possible (onPageStarted) so the
// getUserMedia override is in place before the calling page's own
// scripts ask for the microphone. If the page already grabbed the real
// mic before this ran, call __spudMic.reapply() — it re-installs the
// override for any later getUserMedia call.
//
// State is reported on window.__spudMic (plain fields, no promises
// cross the bridge). The app polls __spudMic.state() for a JSON string.
(function () {
  'use strict';
  if (window.__spudMic) return;
  var M = {};
  window.__spudMic = M;

  M.port = 0;                 // loopback HTTP port (set by the app)
  M.orderState = 'idle';      // idle|loading|playing|done|error:...
  M.replyState = 'idle';
  M.logLines = [];
  M.remoteSeen = false;
  function log(m) {
    M.logLines.push(new Date().toISOString().slice(11, 19) + ' ' + m);
    if (M.logLines.length > 80) M.logLines.shift();
  }
  // Mirror playback state into window.__spud (the dialer script) when
  // it exists, so the app's existing state polling keeps working even
  // though the audio now flows through this virtual mic.
  function setState(key, v) {
    M[key] = v;
    try { if (window.__spud) window.__spud[key] = v; } catch (e) {}
  }

  // ---------- AudioContext + virtual-mic stream ----------
  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = null, dest = null, micStream = null;
  function ensureCtx() {
    if (!ctx) {
      try {
        ctx = new AC();
        dest = ctx.createMediaStreamDestination();
        micStream = dest.stream;
        log('AudioContext created state=' + ctx.state + ' rate=' + ctx.sampleRate);
      } catch (e) {
        log('AudioContext create FAILED: ' + e.message);
        return null;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    return ctx;
  }
  ensureCtx();
  // The context can start suspended until a user gesture; keep resuming.
  setInterval(function () {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
  }, 500);

  // ---------- getUserMedia override (the virtual mic) ----------
  function fakeGetUserMedia(constraints) {
    ensureCtx();
    log('getUserMedia intercepted -> virtual mic stream');
    return Promise.resolve(micStream);
  }
  function installOverride() {
    try {
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = fakeGetUserMedia;
      }
    } catch (e) { log('mediaDevices override FAILED: ' + e.message); }
    try {
      navigator.getUserMedia = function (c, ok, err) {
        ensureCtx();
        log('navigator.getUserMedia intercepted -> virtual mic stream');
        ok(micStream);
      };
    } catch (e) {}
    try {
      if (navigator.webkitGetUserMedia) {
        navigator.webkitGetUserMedia = function (c, ok, err) {
          ensureCtx();
          ok(micStream);
        };
      }
    } catch (e) {}
    try {
      if (navigator.mozGetUserMedia) {
        navigator.mozGetUserMedia = function (c, ok, err) {
          ensureCtx();
          ok(micStream);
        };
      }
    } catch (e) {}
  }
  installOverride();
  // Re-install on demand (the app calls this after navigation, since a
  // new document resets the overrides).
  M.reapply = function () { installOverride(); log('override re-applied'); };

  // ---------- Incoming audio: meter only, never audible ----------
  var remoteAnalyser = null, remoteCtx = null, lastSpeechAt = 0;
  function hookRemote(stream) {
    try {
      if (!remoteCtx) remoteCtx = new AC();
      if (remoteCtx.state === 'suspended') remoteCtx.resume().catch(function () {});
      var src = remoteCtx.createMediaStreamSource(stream);
      var an = remoteCtx.createAnalyser();
      an.fftSize = 2048;
      var zero = remoteCtx.createGain();
      zero.gain.value = 0; // graph renders, nothing is heard
      src.connect(an);
      an.connect(zero);
      zero.connect(remoteCtx.destination);
      remoteAnalyser = an;
      M.remoteSeen = true;
      log('remote track hooked (analyser, zero-gain)');
    } catch (e) { log('hookRemote FAILED: ' + e.message); }
  }
  function wrapTrackHandler(fn) {
    return function (ev) {
      try {
        if (ev && ev.streams && ev.streams[0]) hookRemote(ev.streams[0]);
        else if (ev && ev.track) hookRemote(new MediaStream([ev.track]));
      } catch (e) {}
      if (fn) return fn.call(this, ev);
    };
  }
  try {
    var OrigPC = window.RTCPeerConnection;
    ['ontrack', 'onaddstream'].forEach(function (prop) {
      try {
        Object.defineProperty(OrigPC.prototype, prop, {
          configurable: true,
          get: function () { return this['__spudMic_' + prop]; },
          set: function (fn) { this['__spudMic_' + prop] = wrapTrackHandler(fn); }
        });
      } catch (e) {}
    });
    var origAddEL = OrigPC.prototype.addEventListener;
    OrigPC.prototype.addEventListener = function (type, fn, opts) {
      if (type === 'track' || type === 'addstream') fn = wrapTrackHandler(fn);
      return origAddEL.call(this, type, fn, opts);
    };
  } catch (e) { log('PC hook FAILED: ' + e.message); }

  M.remoteLevel = function () {
    if (!remoteAnalyser) return 0;
    try {
      var buf = new Float32Array(2048);
      remoteAnalyser.getFloatTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      var rms = Math.sqrt(sum / buf.length);
      if (rms > 0.02) lastSpeechAt = Date.now();
      return rms;
    } catch (e) { return 0; }
  };

  // ---------- Play a voice-message file into the virtual mic ----------
  // WEB VARIANT: audio files are fetched from GitHub Pages (https) so
  // there is no localhost / mixed-content problem in a desktop browser.
  var WEB_BASE = 'https://gravyshooter.github.io/cancun-resort-map/spudcall';
  var currentSrc = null;
  function stopCurrent() {
    try { if (currentSrc) currentSrc.stop(); } catch (e) {}
    currentSrc = null;
  }
  // url is a loopback URL, e.g. http://127.0.0.1:PORT/order48.wav
  function playUrl(url, stateKey) {
    ensureCtx();
    if (!ctx || !dest) { setState(stateKey, 'error:no-audio-context'); return; }
    stopCurrent();
    setState(stateKey, 'loading');
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (ab) {
      return new Promise(function (resolve, reject) {
        try {
          var p = ctx.decodeAudioData(ab, resolve, reject);
          if (p && p.then) p.then(resolve, reject);
        } catch (e) { reject(e); }
      });
    }).then(function (buf) {
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.onended = function () {
        if (currentSrc === src) currentSrc = null;
        setState(stateKey, 'done');
      };
      currentSrc = src;
      src.start();
      setState(stateKey, 'playing');
      log('playing into virtual mic: ' + url + ' (' + buf.duration.toFixed(1) + 's, ctx=' + ctx.state + ')');
    }).catch(function (e) {
      setState(stateKey, 'error:' + (e && e.message ? e.message : e));
      log('playUrl FAILED: ' + url + ' ' + (e && e.message ? e.message : e));
    });
  }

  M.setLoopback = function (port) { M.port = port; };
  // The order voice message (48 kHz WAV). `plain` = the variant
  // without the delivery-box sentence.
  M.playOrder = function (plain) {
    var f = plain ? '/order48-plain.wav' : '/order48.wav';
    playUrl(WEB_BASE + f, 'orderState');
  };
  // Play the loopback /order.wav (the dynamic TTS file for the current
  // order) — used when the order is not a pre-recorded Chatty variant.
  M.playOrderFile = function () {
    playUrl(WEB_BASE + '/order.wav', 'orderState');
  };
  M.playReply = function (key) {
    playUrl(WEB_BASE + '/reply/' + key + '.mp3', 'replyState');
  };
  M.stopAudio = function () {
    stopCurrent();
    setState('orderState', 'idle');
    setState('replyState', 'idle');
  };

  // ---------- State for the app to poll ----------
  M.state = function () {
    // Backup remote hook: if the calling page renders the remote stream
    // through an <audio>/<video> element, hook that stream too.
    try {
      document.querySelectorAll('audio,video').forEach(function (el) {
        if (el.srcObject && !el.__spudMicHooked) {
          el.__spudMicHooked = true;
          hookRemote(el.srcObject);
        }
      });
    } catch (e) {}
    return JSON.stringify({
      url: location.href,
      ctxState: ctx ? ctx.state : 'none',
      ctxRate: ctx ? ctx.sampleRate : 0,
      remoteSeen: M.remoteSeen,
      orderState: M.orderState,
      replyState: M.replyState,
      logTail: M.logLines.slice(-6)
    });
  };

  log('__spudMic installed on ' + location.href);
})();
