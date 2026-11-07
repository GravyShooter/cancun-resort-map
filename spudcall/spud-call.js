// spud-call.js — WEB room-service caller (bookmarklet-injected).
//
// Loaded into the FreeCallMe / PopTox dialer page by the SpudCall
// bookmarklet (see caller.html). Runs IN the dialer's origin, so it can
// fill the number, click Call, override getUserMedia with a fake mic,
// mute all remote audio, and drive the call — the same automation the
// Android app does in its WebView, but in plain Safari / Chrome.
//
// Why a bookmarklet: a plain web page cannot inject JS into a
// cross-origin dialer page (same-origin policy). The bookmarklet runs
// in the dialer page's own context, so injection works. The user opens
// freecallme.com (or poptox.com) in their real browser (real device,
// real IP — no datacenter Turnstile block), taps the bookmarklet, and
// this script takes over.
//
// Flow: fetch order + FreeCallMe password from Firebase (anonymous
// auth, API key fetched from the public map page at runtime — nothing
// hardcoded) -> log in to FreeCallMe if needed (OTP via Firebase
// freecallme-auth/code if shown) -> dial -> play the Chatty Porch
// order audio into the fake mic -> listen for staff speech (AnalyserNode
// RMS, no STT) -> play goodbye -> hang up -> report to Firebase.
//
// SAFETY: never dials the front desk (+52 998 872 8500) unless the
// Firebase order has testPassed=true (set by tapping TEST PASSED on
// the order page after a test call where Chris heard the order).
// Test calls go to Chris's +1 740 381 3531.
//
// $0 only: FreeCallMe free credit, PopTox free. No card, no paid.
(function () {
  'use strict';
  if (window.__spudcall) return;
  var S = {};
  window.__spudcall = S;

  // ---------- Config ----------
  var ORDER_ID = '-P5my-uyvJJfZz7Fkrpf';
  var NODE = 'hailmary-orders-2way';
  var AUTH_NODE = 'freecallme-auth';
  var DB_URL = 'https://excellence-riviera-cancu-12f14-default-rtdb.firebaseio.com';
  var MAP_URL = 'https://gravyshooter.github.io/cancun-resort-map/';
  var EMAIL = 'cgd2049@gmail.com';
  var FRONT_DESK = '+529988728500';
  var TEST_NUMBER = '+17403813531';
  // Base URL for reply MP3s, derived from this script's own URL so the
  // files work wherever spud-call.js is hosted (GitHub Pages or artifact).
  var BASE = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (s) return s.slice(0, s.lastIndexOf('/') + 1);
    } catch (e) {}
    return 'https://gravyshooter.github.io/cancun-resort-map/spudcall/';
  })();
  var REPLY_URL = function (key) { return BASE + 'audio/' + key + '.mp3'; };
  var MAX_CALL_MS = 90 * 1000;
  var SPEECH_RMS = 0.02;
  var SILENCE_AFTER_SPEECH_MS = 2500;

  S.last = { ok: false, stage: 'init', info: '' };
  S.logLines = [];
  function log(m) {
    var line = new Date().toISOString().slice(11, 19) + ' ' + m;
    S.logLines.push(line);
    if (S.logLines.length > 60) S.logLines.shift();
    renderPanel();
  }
  function setLast(ok, stage, info) { S.last = { ok: !!ok, stage: stage, info: info || '' }; renderPanel(); }

  // ---------- Status panel (floating, on the dialer page) ----------
  var panel = null, panelBody = null, panelTitle = null;
  function renderPanel() {
    if (!panel) return;
    try {
      panelTitle.textContent = 'SpudCall — ' + S.last.stage + (S.last.ok ? ' ✓' : '');
      panelBody.textContent = (S.last.info ? S.last.info + '\n' : '') + S.logLines.slice(-8).join('\n');
    } catch (e) {}
  }
  function makePanel() {
    if (panel) return;
    try {
      panel = document.createElement('div');
      panel.id = 'spudcall-panel';
      panel.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;background:#111;color:#0f0;font:12px/1.5 monospace;padding:10px;border-radius:10px;opacity:.96;max-height:38vh;overflow:auto;box-shadow:0 4px 24px rgba(0,0,0,.5)';
      panelTitle = document.createElement('div');
      panelTitle.style.cssText = 'font-weight:700;color:#fff;margin-bottom:4px';
      panelTitle.textContent = 'SpudCall — starting…';
      panelBody = document.createElement('pre');
      panelBody.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word';
      var hang = document.createElement('button');
      hang.textContent = 'HANG UP';
      hang.style.cssText = 'margin-top:8px;padding:8px 14px;background:#c00;color:#fff;border:0;border-radius:8px;font-weight:700';
      hang.onclick = function () { try { S.hangup(); } catch (e) {} setLast(false, 'hung-up-by-user', ''); };
      panel.appendChild(panelTitle);
      panel.appendChild(panelBody);
      panel.appendChild(hang);
      (document.body || document.documentElement).appendChild(panel);
    } catch (e) {}
  }
  makePanel();

  // ---------- Firebase (REST, anonymous auth — same as the runner) ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function b64ToU8(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function getApiKey() {
    var res = await fetch(MAP_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('map page HTTP ' + res.status);
    var html = await res.text();
    var m = html.match(/apiKey\s*:\s*["']([^"']+)["']/);
    if (!m) throw new Error('apiKey not found in map page');
    return m[1];
  }
  async function signInAnonymously(apiKey) {
    var res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(apiKey),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body.idToken) throw new Error('anonymous sign-in failed');
    return body.idToken;
  }
  async function fbRead(path, idToken) {
    var res = await fetch(DB_URL + '/' + path + '.json?auth=' + encodeURIComponent(idToken), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return res.json().catch(function () { return null; });
  }
  async function fbPatch(path, idToken, patch) {
    var res = await fetch(DB_URL + '/' + path + '.json?auth=' + encodeURIComponent(idToken),
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!res.ok) throw new Error('firebase patch failed HTTP ' + res.status);
    return res.json().catch(function () { return {}; });
  }
  async function fbAuth() {
    var apiKey = await getApiKey();
    var idToken = await signInAnonymously(apiKey);
    return { apiKey: apiKey, idToken: idToken };
  }

  // ---------- Spoken script text (English; display + fallback) ----------
  var EN_NUM = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
  function pluralizeEn(name) {
    if (/s$/i.test(name)) return name;
    if (/(x|z|ch|sh)$/i.test(name)) return name + 'es';
    return name + 's';
  }
  function buildScriptText(order) {
    var room = String(order.room || '6131').trim();
    var guest = String(order.guestName || order.guest || 'Chris').trim() || 'Chris';
    var items = order.items || [];
    var phrases = items.map(function (it) {
      var qty = it.qty || 1;
      var name = String(it.name || '').trim();
      if (qty > 1) name = pluralizeEn(name);
      var q = EN_NUM[qty] || String(qty);
      var p = q + ' ' + name;
      if (it.notes) p += ', ' + it.notes;
      return p;
    });
    var itemsText = phrases.length === 1 ? phrases[0]
      : phrases.length === 2 ? phrases[0] + ', and ' + phrases[1]
      : phrases.slice(0, -1).join(', ') + ', and ' + phrases[phrases.length - 1];
    var out = [];
    out.push('Hi, this is ' + guest + ', room ' + room + '. Can I order some room service, please?');
    if (itemsText) out.push('Can I get ' + itemsText + '?');
    var notes = String(order.deliveryNotes || '').trim();
    if (notes) out.push(/[.!?]$/.test(notes) ? notes : notes + '.');
    out.push('That\u2019s everything. Thanks so much!');
    return out.join(' ');
  }

  // ---------- Silence: mute every media element ----------
  function muteEl(el) { try { el.muted = true; el.volume = 0; } catch (e) {} }
  function muteAll() { try { document.querySelectorAll('audio,video').forEach(muteEl); } catch (e) {} }
  muteAll();
  try {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (!n || !n.tagName) return;
          if (/AUDIO|VIDEO/.test(n.tagName)) muteEl(n);
          if (n.querySelectorAll) n.querySelectorAll('audio,video').forEach(muteEl);
        });
      });
    }).observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch (e) {}
  try {
    var origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { muteEl(this); return origPlay.call(this); };
  } catch (e) {}

  // ---------- Fake mic ----------
  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = null, dest = null, micStream = null;
  function ensureCtx() {
    if (!ctx) {
      try {
        ctx = new AC();
        dest = ctx.createMediaStreamDestination();
        micStream = dest.stream;
        log('AudioContext created state=' + ctx.state + ' rate=' + ctx.sampleRate);
      } catch (e) { log('AudioContext create FAILED: ' + e.message); return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    return ctx;
  }
  ensureCtx();
  setInterval(function () { if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {}); }, 800);
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = function () {
      ensureCtx();
      log('getUserMedia intercepted -> fake mic stream');
      return Promise.resolve(micStream);
    };
  }
  try {
    if (navigator.getUserMedia) {
      navigator.getUserMedia = function (c, ok) { ensureCtx(); ok(micStream); };
    }
  } catch (e) {}

  // ---------- Remote (incoming) capture: meter only, never audible ----------
  var remoteAnalyser = null, remoteSeen = false, lastSpeechAt = 0;
  var remoteCtx = null;
  function hookRemote(stream) {
    try {
      if (!remoteCtx) remoteCtx = new AC();
      if (remoteCtx.state === 'suspended') remoteCtx.resume().catch(function () {});
      var src = remoteCtx.createMediaStreamSource(stream);
      var an = remoteCtx.createAnalyser();
      an.fftSize = 2048;
      var zero = remoteCtx.createGain();
      zero.gain.value = 0;
      src.connect(an);
      an.connect(zero);
      zero.connect(remoteCtx.destination);
      remoteAnalyser = an;
      remoteSeen = true;
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
          get: function () { return this['__spud_' + prop]; },
          set: function (fn) { this['__spud_' + prop] = wrapTrackHandler(fn); }
        });
      } catch (e) {}
    });
    var origAddEL = OrigPC.prototype.addEventListener;
    OrigPC.prototype.addEventListener = function (type, fn, opts) {
      if (type === 'track' || type === 'addstream') fn = wrapTrackHandler(fn);
      return origAddEL.call(this, type, fn, opts);
    };
  } catch (e) { log('PC hook FAILED: ' + e.message); }
  S.remoteLevel = function () {
    if (!remoteAnalyser) return 0;
    try {
      var buf = new Float32Array(2048);
      remoteAnalyser.getFloatTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      var rms = Math.sqrt(sum / buf.length);
      if (rms > SPEECH_RMS) lastSpeechAt = Date.now();
      return rms;
    } catch (e) { return 0; }
  };
  // Backup: hook any <audio>/<video> carrying the remote stream.
  S.scanMediaElements = function () {
    try {
      document.querySelectorAll('audio,video').forEach(function (el) {
        if (el.srcObject && !el.__spudHooked) { el.__spudHooked = true; hookRemote(el.srcObject); }
      });
    } catch (e) {}
  };

  // ---------- Play audio into the fake mic ----------
  var currentSrc = null;
  function stopCurrent() { try { if (currentSrc) currentSrc.stop(); } catch (e) {} currentSrc = null; }
  function playBuffer(buf, stateKey) {
    return new Promise(function (resolve) {
      ensureCtx();
      if (!ctx || !dest) { log('playBuffer: no audio context'); resolve(); return; }
      stopCurrent();
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.onended = function () { if (currentSrc === src) currentSrc = null; resolve(); };
      currentSrc = src;
      src.start();
      log('playing into fake mic (' + buf.duration.toFixed(1) + 's, ctx=' + ctx.state + ')');
    });
  }
  function decodeAudio(ab) {
    ensureCtx();
    return new Promise(function (resolve, reject) {
      try {
        var p = ctx.decodeAudioData(ab, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      } catch (e) { reject(e); }
    });
  }
  async function playUrl(url) {
    var res = await fetch(url);
    if (!res.ok) throw new Error('audio HTTP ' + res.status + ' ' + url);
    var ab = await res.arrayBuffer();
    var buf = await decodeAudio(ab);
    await playBuffer(buf);
  }
  async function playOrderAudio(order) {
    // Prefer the pre-generated Chatty Porch order audio in Firebase.
    var b64 = order && order.orderAudioB64;
    if (typeof b64 === 'string' && b64.length > 100) {
      try {
        var u8 = b64ToU8(b64);
        var buf = await decodeAudio(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
        log('order audio: Chatty Porch from Firebase (' + buf.duration.toFixed(1) + 's)');
        await playBuffer(buf);
        return true;
      } catch (e) { log('orderAudioB64 decode failed: ' + e.message + ' — will not speak a stale/wrong order'); return false; }
    }
    log('no order audio in Firebase for this order — not speaking (parent generates Chatty Porch audio into Firebase)');
    return false;
  }
  async function playReply(key) {
    try { await playUrl(REPLY_URL(key)); return true; }
    catch (e) { log('reply ' + key + ' failed: ' + e.message); return false; }
  }
  S.stopAudio = function () { stopCurrent(); };

  // ---------- Page helpers ----------
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function qAll(sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; } }
  function visible(el) {
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      var cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) { return true; }
  }
  function setInputValue(el, value) {
    try {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
    } catch (e) { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function btnByText(re) {
    var btns = qAll('button');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].innerText || btns[i].textContent || '').trim();
      if (re.test(t) && visible(btns[i])) return btns[i];
    }
    return null;
  }
  function digitsOnly(n) { return String(n).replace(/\D/g, ''); }
  function splitNumber(n) {
    var d = digitsOnly(n);
    if (d.length === 11 && d.charAt(0) === '1') return { cc: '1', national: d.slice(1) };
    if (d.length === 12 && d.slice(0, 2) === '52') return { cc: '52', national: d.slice(2) };
    if (d.length === 10) return { cc: '1', national: d };
    return { cc: '', national: d };
  }
  async function pickCountry(cc, names) {
    var btn = q('button[aria-label^="Country:"]');
    if (btn) {
      btn.click();
      await sleep(900);
      var opts = qAll('[role="option"], [role="listbox"] button, [role="listbox"] li');
      for (var i = 0; i < opts.length; i++) {
        var t = (opts[i].innerText || opts[i].textContent || '').trim();
        if (names.some(function (nm) { return t.toLowerCase().indexOf(nm.toLowerCase()) >= 0; })) {
          opts[i].click(); await sleep(500); return true;
        }
      }
      try { document.body.click(); } catch (e) {}
      await sleep(300);
      return false;
    }
    var sel = q('select');
    if (sel) {
      var o = qAll('select option');
      for (var j = 0; j < o.length; j++) {
        var ot = (o[j].innerText || o[j].textContent || '');
        if (names.some(function (nm) { return ot.toLowerCase().indexOf(nm.toLowerCase()) >= 0; })) {
          sel.value = o[j].value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(400);
          return true;
        }
      }
    }
    return false;
  }
  function inCallNow() {
    S.scanMediaElements();
    if (btnByText(/^(end call|end|hang up|disconnect)$/i)) return true;
    var m = (document.body ? document.body.innerText : '').match(/\b\d{1,2}:\d{2}\b/);
    if (m && btnByText(/mute|keypad|speaker/i)) return true;
    return false;
  }
  S.hangup = function () {
    var endBtn = btnByText(/^(end call|end|hang up|disconnect)$/i);
    if (endBtn) { stopCurrent(); endBtn.click(); return true; }
    var alt = q('button[aria-label*="End" i], button[title*="End" i]');
    if (alt) { stopCurrent(); alt.click(); return true; }
    return false;
  };

  // ---------- FreeCallMe login / OTP ----------
  async function waitForCode(idToken, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 10 * 60 * 1000);
    for (;;) {
      try {
        var auth = await fbRead(AUTH_NODE, idToken);
        if (auth && typeof auth.code === 'string' && /^\d{6}$/.test(auth.code)) return auth.code;
        var order = await fbRead(NODE + '/' + ORDER_ID, idToken);
        if (order && typeof order.code === 'string' && /^\d{6}$/.test(order.code)) return order.code;
      } catch (e) {}
      if (Date.now() > deadline) throw new Error('timed out waiting for the login code in Firebase');
      await sleep(5000);
    }
  }
  async function doLogin(email, pw, idToken) {
    setLast(false, 'login-start', '');
    var firstName = q('#firstName, input[name="firstName" i], input[autocomplete="given-name"]');
    if (firstName && visible(firstName)) {
      var link = q('a[href="/login"]') || btnByText(/already have an account/i) || btnByText(/sign in/i);
      if (link) { link.click(); await sleep(1200); }
    }
    var em = q('input[type="email"]');
    var pass = q('input[type="password"]');
    if (!em || !pass) { setLast(false, 'no-login-form', location.href); return false; }
    setInputValue(em, email);
    setInputValue(pass, pw);
    await sleep(400);
    var submit = btnByText(/^sign in$/i) || q('button[type="submit"]');
    if (!submit || submit.disabled) { setLast(false, 'login-submit-disabled', ''); return false; }
    submit.click();
    await sleep(2500);
    if (qAll('input[maxlength="1"]').length >= 4 || q('input[autocomplete="one-time-code"]')) {
      setLast(false, 'otp-needed', 'A 6-digit code was requested — the code is being relayed via Firebase…');
      log('OTP screen — polling Firebase for the code (up to 10 min)');
      try {
        var code = await waitForCode(idToken, 10 * 60 * 1000);
        var boxes = qAll('input[maxlength="1"]');
        if (boxes.length >= 4) {
          for (var i = 0; i < boxes.length && i < code.length; i++) setInputValue(boxes[i], code[i]);
        } else {
          var single = q('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i], input[name*="otp" i]');
          if (single) setInputValue(single, code);
        }
        await sleep(400);
        var verify = btnByText(/verify|continue/i) || q('button[type="submit"]');
        if (verify) verify.click();
        await sleep(2500);
        if (q('input[type="tel"]')) { setLast(true, 'dial-ready', ''); return true; }
        setLast(false, 'code-rejected', ''); return false;
      } catch (e) { setLast(false, 'otp-timeout', e.message); return false; }
    }
    if (q('input[type="tel"]') && visible(q('input[type="tel"]'))) { setLast(true, 'dial-ready', ''); return true; }
    if (q('input[type="email"]') && visible(q('input[type="email"]'))) { setLast(false, 'login-failed', 'still on login form'); return false; }
    setLast(true, 'logged-in', location.href);
    return true;
  }

  // ---------- Dial ----------
  async function doDial(number) {
    setLast(false, 'dial-start', number);
    var split = splitNumber(number);
    var names = split.cc === '52' ? ['Mexico', 'México'] : ['United States', 'USA'];
    var picked = await pickCountry(split.cc, names);
    var tel = q('input[type="tel"]') || q('input[inputmode="tel"]');
    if (!tel) { setLast(false, 'no-dialer', location.href); return false; }
    setInputValue(tel, picked ? (split.national || digitsOnly(number)) : digitsOnly(number));
    await sleep(500);
    var callBtn = btnByText(/call now/i) || btnByText(/^call$/i);
    if (!callBtn) { setLast(false, 'no-call-button', ''); return false; }
    callBtn.click();
    await sleep(2000);
    if (q('input[type="email"]') && visible(q('input[type="email"]'))) { setLast(false, 'needs-login', ''); return 'login'; }
    setLast(true, 'calling', number);
    return true;
  }
  async function doDialPopTox(number) {
    setLast(false, 'dial-start', number);
    var split = splitNumber(number);
    var names = split.cc === '52' ? ['Mexico', 'México'] : ['United States', 'USA'];
    var picked = await pickCountry(split.cc, names);
    var tel = q('input[type="tel"]') || q('input[inputmode="tel"]') || q('input[name*="phone" i]') || q('input[placeholder*="number" i]');
    if (!tel) { setLast(false, 'no-dialer', location.href); return false; }
    setInputValue(tel, picked ? (split.national || digitsOnly(number)) : digitsOnly(number));
    await sleep(500);
    var callBtn = btnByText(/^call$/i) || btnByText(/call now/i);
    if (!callBtn) { setLast(false, 'no-call-button', ''); return false; }
    callBtn.click();
    await sleep(2000);
    setLast(true, 'calling', number);
    return true;
  }

  // ---------- Conversation (no STT: detect speech, reply, hang up) ----------
  async function conversation() {
    var t0 = Date.now();
    var heard = false;
    var saidGoodbye = false;
    while (Date.now() - t0 < MAX_CALL_MS) {
      S.scanMediaElements();
      var level = S.remoteLevel();
      if (level > SPEECH_RMS) heard = true;
      if (heard && Date.now() - lastSpeechAt > SILENCE_AFTER_SPEECH_MS && !saidGoodbye) {
        log('staff finished speaking — saying goodbye');
        saidGoodbye = true;
        await playReply('goodbye');
        await sleep(1000);
        S.hangup();
        return 'goodbye';
      }
      if (!heard && Date.now() - t0 > 20000) {
        log('no staff speech heard in 20s after the order — hanging up');
        S.hangup();
        return 'no-speech';
      }
      if (!inCallNow() && Date.now() - t0 > 8000) {
        log('call ended (no in-call UI) — hanging up');
        return 'ended';
      }
      await sleep(200);
    }
    log('max call time reached — hanging up');
    S.hangup();
    return 'timeout';
  }

  // ---------- Main flow ----------
  async function main() {
    setLast(false, 'starting', location.href);
    var host = location.hostname || '';
    var backend = /freecallme\.com/i.test(host) ? 'freecallme' : /poptox\.com/i.test(host) ? 'poptox' : '';
    if (!backend) {
      setLast(false, 'wrong-page', 'Open freecallme.com (or poptox.com) first, then tap the SpudCall bookmarklet.');
      log('This page is ' + host + ' — not a dialer. Open freecallme.com or poptox.com, then tap the bookmarklet.');
      return;
    }
    log('backend: ' + backend + ' on ' + host);
    var auth;
    try {
      auth = await fbAuth();
      log('Firebase anonymous auth OK');
    } catch (e) { setLast(false, 'firebase-auth-failed', e.message); return; }
    var order = null;
    try { order = await fbRead(NODE + '/' + ORDER_ID, auth.idToken); } catch (e) {}
    if (!order) { setLast(false, 'no-order', 'No order in Firebase — build one on the order page first.'); return; }
    var to = String(order.to || TEST_NUMBER).trim();
    var isFrontDesk = digitsOnly(to) === digitsOnly(FRONT_DESK);
    if (isFrontDesk && order.testPassed !== true) {
      setLast(false, 'blocked-front-desk', 'Front desk is LOCKED until a test call passes. Tap TEST PASSED on the order page first.');
      log('Refused to dial the front desk: testPassed is not set. Run the test call to +1 740-381-3531 first.');
      return;
    }
    log('order: room ' + (order.room || '6131') + ', ' + (order.items || []).length + ' items, to ' + to + (isFrontDesk ? ' (FRONT DESK)' : ' (test)'));
    log('saying: ' + buildScriptText(order));
    try { await fbPatch(NODE + '/' + ORDER_ID, auth.idToken, { status: 'calling', callStartedAt: Date.now() }); } catch (e) {}

    if (backend === 'freecallme') {
      var pw = null;
      try {
        var authNode = await fbRead(AUTH_NODE, auth.idToken);
        pw = authNode && authNode.password;
      } catch (e) {}
      var needsLogin = !!(q('input[type="email"]') && visible(q('input[type="email"]')));
      if (needsLogin) {
        if (!pw) { setLast(false, 'no-password', 'FreeCallMe password not in Firebase — cannot log in.'); return; }
        var ok = await doLogin(EMAIL, pw, auth.idToken);
        if (!ok) { try { await fbPatch(NODE + '/' + ORDER_ID, auth.idToken, { status: 'login-failed', result: S.last }); } catch (e) {} return; }
      } else {
        log('already on the dialer (no login form) — skipping login');
      }
      var dialed = await doDial(to);
      if (dialed === 'login') {
        if (!pw) { setLast(false, 'no-password', 'FreeCallMe password not in Firebase — cannot log in.'); return; }
        var ok2 = await doLogin(EMAIL, pw, auth.idToken);
        if (!ok2) return;
        dialed = await doDial(to);
      }
      if (!dialed) return;
    } else {
      var okP = await doDialPopTox(to);
      if (!okP) return;
    }

    // Wait for the call to connect (in-call UI), up to 30s.
    var connected = false;
    for (var i = 0; i < 150; i++) {
      if (inCallNow()) { connected = true; break; }
      await sleep(200);
    }
    if (!connected) {
      setLast(false, 'not-connected', 'No in-call screen after dialing — the call may not have connected.');
      try { await fbPatch(NODE + '/' + ORDER_ID, auth.idToken, { status: 'not-connected', result: S.last }); } catch (e) {}
      return;
    }
    setLast(true, 'in-call', 'Connected — playing the order…');
    log('in call — waiting 1.5s for the staff greeting, then playing the order');
    await sleep(1500);
    var played = await playOrderAudio(order);
    if (!played) {
      setLast(false, 'no-order-audio', 'No Chatty Porch audio in Firebase for this order — hanging up without speaking.');
      S.hangup();
      try { await fbPatch(NODE + '/' + ORDER_ID, auth.idToken, { status: 'no-order-audio', result: S.last }); } catch (e) {}
      return;
    }
    log('order played — listening for the staff…');
    var outcome = await conversation();
    setLast(true, 'done', 'Call outcome: ' + outcome);
    try { await fbPatch(NODE + '/' + ORDER_ID, auth.idToken, { status: 'done', result: { outcome: outcome, at: Date.now() } }); } catch (e) {}
    log('done: ' + outcome + '. If this was the test call and you heard the order, tap TEST PASSED on the order page to unlock the front desk.');
  }

  // Expose a little API for the order page / debugging, then auto-run.
  S.run = main;
  S.buildScriptText = buildScriptText;
  S.state = function () {
    return { url: location.href, ctxState: ctx ? ctx.state : 'none', remoteSeen: remoteSeen, inCall: inCallNow(), last: S.last, logTail: S.logLines.slice(-6) };
  };
  main().catch(function (e) { setLast(false, 'error', e && e.message ? e.message : String(e)); });
})();
