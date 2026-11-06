// gha-call.js — TWO-WAY conversational room-service caller for
// GitHub Actions (a free host where WebRTC/UDP works — this VM
// blocks it, so the caller cannot run here).
//
//   Live: log in to TextNow (passwordless, 6-digit code), dial the
//   front desk, play the order script (Chatty Porch, natural wording),
//   then LISTEN: capture the staff's voice from the WebRTC call,
//   transcribe it with whisper.cpp (free, offline), respond with a
//   rule-based reply (pre-generated Chatty Porch audio), and loop
//   until the staff says goodbye or ~90s pass. Then hang up and
//   report the outcome + transcript to Firebase.
//
//   Dry run (default, safe): verify the host supports WebRTC media
//   (UDP socket, TURN ICE, two-peer connection) and run the full
//   listen→transcribe→respond→speak loop against a simulated staff
//   peer (two PeerConnections in-page). No TextNow, no login, no dial.
//
//   node gha-call.js --order-id <firebasePushId> [--order order.json]
//                    [--order-audio order.mp3] [--code 123456]
//                    [--to +529988728500] [--dry-run|--live]
//                    [--result result.json] [--json]
//
// Inputs:
//   --order-id     Firebase hailmary-orders push ID. The order (and
//                  optional orderAudioB64 + code) is read from Firebase.
//   --order        Order JSON file (alternative to --order-id).
//   --order-audio  Chatty Porch MP3 of the order script (preferred).
//                  If omitted, the workflow uses orderAudioB64 from
//                  Firebase; if neither is present, espeak-ng is used
//                  as a last resort (robotic — the parent should supply
//                  Chatty Porch audio for the real call).
//   --code         6-digit TextNow login code (direct). Otherwise the
//                  code is polled from Firebase (parent writes it after
//                  reading Gmail) — see firebase.js waitForCode.
//   --dry-run      Run the host + loop verification only (default).
//   --live         Place a real call (needs HAILMARY_LIVE=1).
//   --result       Write the result JSON to this file (in addition to
//                  Firebase + console).
//
// The script wording and closing come from script.js (natural,
// "That's everything. Thanks so much!" — no "how long" question).
// The voice is Chatty Porch (avocado_v2:vdc_23184) for the order and
// for every rule-based reply (pre-generated MP3s in audio/).

const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { chromium } = require('playwright');
const { buildScript } = require('./script');
const { respond } = require('./respond');
const { transcribe } = require('./whisper');
const fb = require('./firebase');

const INJECT = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
const DEFAULT_TO = '+529988728500'; // Excellence Riviera Cancun front desk
const DEFAULT_EMAIL = 'cgd2049+textnow@gmail.com';
const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const AUDIO_DIR = __dirname; // flat repo-root layout: reply MP3s sit next to this file
const CONVERSATION_TIMEOUT_MS = 90 * 1000; // max two-way conversation
const UTTERANCE_SILENCE_MS = 1500; // silence after speech = end of utterance
const REMOTE_LEVEL_THRESHOLD = 0.02; // RMS above this = staff speaking
const CODE_WAIT_MS = 10 * 60 * 1000;

const SELECTORS = {
  loginUrl: 'https://www.textnow.com/login?redirectTo=/messaging',
  appUrl: 'https://www.textnow.com/messaging',
  continueWithEmail: 'text=Continue with Email',
  email: '#email',
  emailContinue: 'button:has-text("Continue")',
  codeInput: 'input[maxlength="1"], input[autocomplete="one-time-code"], input[inputmode="numeric"]',
  codeBoxes: 'input[maxlength="1"]',
  codeSingle: 'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i], input[placeholder*="code" i]',
  codeSubmit: 'button:has-text("Verify"), button:has-text("Continue"), button[type="submit"]',
  codeError: 'text=/incorrect|wrong|invalid|expired|try again/i',
  newCallButton: 'button:has-text("Call"), [aria-label*="Call" i], [title*="Call" i]',
  dialInput: 'input[type="tel"], input[placeholder*="number" i], input[inputmode="tel"]',
  callButton: 'button:has-text("Call"), [aria-label*="Call" i]',
  inCall: '[class*="call" i], [aria-label*="call" i]',
  endCallButton: 'button:has-text("End"), [aria-label*="End call" i], [aria-label*="Hang up" i], button[title*="End" i]',
};

function log(step, msg) {
  console.log(new Date().toISOString().slice(11, 19) + '  [' + step + '] ' + msg);
}
function event(obj) { console.log('EVENT ' + JSON.stringify(obj)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArgs(argv) {
  const a = { orderId: '', order: null, orderAudio: '', code: '', to: DEFAULT_TO, live: false, json: false, result: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--order-id') a.orderId = argv[++i];
    else if (argv[i] === '--order') a.order = argv[++i];
    else if (argv[i] === '--order-audio') a.orderAudio = argv[++i];
    else if (argv[i] === '--code') a.code = argv[++i];
    else if (argv[i] === '--to') a.to = argv[++i];
    else if (argv[i] === '--live') a.live = true;
    else if (argv[i] === '--dry-run') a.live = false;
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--result') a.result = argv[++i];
  }
  return a;
}

function chromiumOpts(extraArgs) {
  const opts = {
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'].concat(extraArgs || []),
  };
  // On GitHub Actions Playwright installs its own Chromium; on this VM
  // the path is fixed. Honour an explicit path when set.
  if (process.env.PLAYWRIGHT_CHROME_PATH) opts.executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  return opts;
}

// ---------- WebRTC host check (dry-run phase 1) ----------
// Returns { udpOk, turnRelay, twoPeerConnected, twoPeerRms }.
// UDP: direct socket send to loopback + to a public STUN host.
// TURN: ICE gathering against openrelay.metered.ca (TCP/TLS).
// Two-peer: two RTCPeerConnections in-page, tone flows A -> B.
async function hostCheck() {
  const out = { udpOk: false, turnRelay: false, twoPeerConnected: false, twoPeerRms: 0 };
  // UDP socket send (loopback). EPERM here = the host blocks UDP.
  try {
    await new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.send(Buffer.from('ping'), 12345, '127.0.0.1', (err) => { s.close(); err ? reject(err) : resolve(); });
      setTimeout(() => { try { s.close(); } catch (_) {} reject(new Error('udp send timeout')); }, 5000);
    });
    out.udpOk = true;
    log('host', 'UDP socket send to loopback: OK');
  } catch (e) {
    log('host', 'UDP socket send to loopback: FAIL (' + e.message + ')');
  }

  const browser = await chromium.launch(chromiumOpts(['--disable-features=WebRtcHideLocalIpsWithMdns']));
  try {
    const page = await browser.newPage();
    await page.addInitScript(INJECT);
    await page.goto('about:blank');
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ];
    const cands = await page.evaluate(async (iceServers) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const pc = new RTCPeerConnection({ iceServers });
      const found = [];
      pc.onicecandidate = (e) => { if (e.candidate) found.push(e.candidate.candidate); };
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      await pc.createOffer().then((o) => pc.setLocalDescription(o));
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        if (pc.iceGatheringState === 'complete') break;
        await sleep(250);
      }
      return { gathering: pc.iceGatheringState, candidates: found };
    }, iceServers);
    const relay = cands.candidates.filter((c) => c.includes(' typ relay '));
    const host = cands.candidates.filter((c) => c.includes(' typ host '));
    const srflx = cands.candidates.filter((c) => c.includes(' typ srflx '));
    log('host', 'ICE candidates: host=' + host.length + ' srflx=' + srflx.length + ' relay=' + relay.length + ' (gathering ' + cands.gathering + ')');
    out.turnRelay = relay.length > 0;
    if (out.udpOk && (host.length > 0 || srflx.length > 0)) {
      // UDP path exists — try two peers over host/srflx.
      const two = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const hm = window.__hailmary;
        const pcA = new RTCPeerConnection();
        const pcB = new RTCPeerConnection();
        pcA.onicecandidate = (e) => { if (e.candidate) pcB.addIceCandidate(e.candidate).catch(() => {}); };
        pcB.onicecandidate = (e) => { if (e.candidate) pcA.addIceCandidate(e.candidate).catch(() => {}); };
        let remoteLevel = 0;
        let remoteCtxState = '';
        pcB.ontrack = (ev) => {
          const track = ev.track;
          const src = new (window.AudioContext || window.webkitAudioContext)();
          // Headless Chrome starts a new AudioContext suspended; a suspended
          // context feeds silence to the Analyser even when the track carries
          // audio, so RMS reads 0 and the host check fails. Resume it.
          src.resume().catch(() => {});
          remoteCtxState = src.state;
          const analyser = src.createAnalyser();
          analyser.fftSize = 2048;
          src.createMediaStreamSource(new MediaStream([track])).connect(analyser);
          const buf = new Float32Array(2048);
          const iv = setInterval(() => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);
            if (rms > remoteLevel) remoteLevel = rms;
          }, 100);
          setTimeout(() => clearInterval(iv), 12000);
        };
        pcA.addTrack(hm.mic.getAudioTracks()[0], hm.mic);
        const offer = await pcA.createOffer();
        await pcA.setLocalDescription(offer);
        await pcB.setRemoteDescription(offer);
        const answer = await pcB.createAnswer();
        await pcB.setLocalDescription(answer);
        await pcA.setRemoteDescription(answer);
        hm.tone(880, 10.0);
        const t0 = Date.now();
        let state = '';
        while (Date.now() - t0 < 30000) {
          state = pcA.connectionState + '/' + pcA.iceConnectionState;
          if (pcA.connectionState === 'connected') break;
          await sleep(250);
        }
        await sleep(3000);
        return { state, remoteLevel, remoteCtxState, micLevel: (typeof hm.micLevel === 'function' ? hm.micLevel() : -1) };
      });
      log('host', 'two-peer: state=' + two.state + ' remote RMS=' + two.remoteLevel.toFixed(4) + ' remoteCtx=' + (two.remoteCtxState || '?') + ' micLevel=' + (typeof two.micLevel === 'number' ? two.micLevel.toFixed(4) : '?'));
      out.twoPeerConnected = two.state.startsWith('connected');
      out.twoPeerRms = +two.remoteLevel.toFixed(4);
    }
  } finally {
    await browser.close();
  }
  return out;
}

// ---------- Audio helpers ----------
// Play an MP3 buffer into the fake mic on the given page. Returns duration.
async function playAudio(page, audioBuf) {
  const b64 = audioBuf.toString('base64');
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return window.__hailmary.sayBuffer(bytes.buffer);
  }, b64);
}

// Synthesize the order script with espeak-ng (last-resort fallback when
// no Chatty Porch audio was supplied). Robotic — the parent should supply
// Chatty Porch audio for the real call. Returns an MP3 Buffer, or null.
async function espeakSynthesize(text) {
  const { execFile } = require('child_process');
  const os = require('os');
  const tmpWav = path.join(os.tmpdir(), 'hailmary-espeak-' + Date.now() + '.wav');
  const tmpMp3 = tmpWav + '.mp3';
  try {
    await new Promise((resolve, reject) => {
      execFile('espeak-ng', ['-s', '140', '-w', tmpWav, text], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
    });
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-v', 'error', '-i', tmpWav, '-codec:a', 'libmp3lame', '-q:a', '4', tmpMp3], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
    });
    return fs.readFileSync(tmpMp3);
  } catch (e) {
    log('tts', 'espeak fallback failed: ' + e.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpWav); } catch (_) {}
    try { fs.unlinkSync(tmpMp3); } catch (_) {}
  }
}

// Resolve the order audio: --order-audio file, then Firebase
// orderAudioB64, then espeak fallback. Returns { audio, source }.
async function resolveOrderAudio(args, order, firebaseOrder) {
  if (args.orderAudio) {
    const buf = fs.readFileSync(args.orderAudio);
    log('tts', 'order audio from --order-audio (' + buf.length + ' bytes, Chatty Porch expected)');
    return { audio: buf, source: 'file' };
  }
  const b64 = firebaseOrder && firebaseOrder.orderAudioB64;
  if (typeof b64 === 'string' && b64.length > 100) {
    const buf = Buffer.from(b64, 'base64');
    log('tts', 'order audio from Firebase orderAudioB64 (' + buf.length + ' bytes, Chatty Porch)');
    return { audio: buf, source: 'firebase' };
  }
  log('tts', 'no Chatty Porch order audio supplied — falling back to espeak-ng (robotic)');
  const script = buildScript(order);
  const buf = await espeakSynthesize(script.text);
  if (!buf) throw new Error('no order audio available (no --order-audio, no Firebase orderAudioB64, espeak failed)');
  return { audio: buf, source: 'espeak' };
}

// ---------- Two-way conversation loop ----------
// Listens on the live call page, transcribes staff utterances with
// Whisper, responds with rule-based Chatty Porch audio, and loops
// until goodbye or timeout. Returns { transcript: [{at, speaker, text}], turns }.
async function converse(page, order, orderAudio, script, remoteState) {
  const transcript = [];
  // remoteState = { chunks: [Buffer], lastChunkAt: ms } — shared with
  // the __sendAudioChunk handler exposed in liveCall (before dialing),
  // so no early staff audio is dropped.
  const chunks = remoteState.chunks;
  let speaking = false;
  let lastSpeechAt = 0;
  let turns = 0;
  let ended = false;

  async function transcribeAccumulated() {
    if (!chunks.length) return '';
    const webm = Buffer.concat(chunks);
    chunks.length = 0;
    const tmp = path.join(__dirname, 'remote-' + Date.now() + '.webm');
    try {
      fs.writeFileSync(tmp, webm);
      const text = await transcribe(tmp);
      return text;
    } catch (e) {
      log('stt', 'transcription failed: ' + e.message);
      return '';
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  async function speakReply(key) {
    const file = path.join(AUDIO_DIR, key + '.mp3');
    const buf = fs.readFileSync(file);
    const dur = await playAudio(page, buf);
    log('speak', 'reply "' + key + '" played (' + dur.toFixed(1) + 's)');
    await sleep(Math.min(dur * 1000 + 400, 6000));
  }

  const t0 = Date.now();
  log('listen', 'two-way loop started (timeout ' + (CONVERSATION_TIMEOUT_MS / 1000) + 's)');
  while (Date.now() - t0 < CONVERSATION_TIMEOUT_MS && !ended) {
    const level = await page.evaluate(() => {
      try { return window.__hailmary.remoteLevel(); } catch (_) { return 0; }
    }).catch(() => 0);
    const now = Date.now();
    if (level > REMOTE_LEVEL_THRESHOLD) {
      if (!speaking) { speaking = true; log('listen', 'staff speaking (level ' + level.toFixed(3) + ')'); }
      lastSpeechAt = now;
    } else if (speaking && now - lastSpeechAt > UTTERANCE_SILENCE_MS && now - remoteState.lastChunkAt > 500) {
      // End of an utterance — transcribe it and respond.
      speaking = false;
      const text = await transcribeAccumulated();
      if (!text) { log('stt', 'utterance transcribed as empty — keep listening'); continue; }
      transcript.push({ at: new Date().toISOString(), speaker: 'staff', text });
      log('staff', '"' + text + '"');
      const res = respond(text, order);
      turns += 1;
      if (res.action === 'none') {
        log('respond', 'noise/empty — no reply, keep listening');
        continue;
      }
      if (res.action === 'repeat') {
        transcript.push({ at: new Date().toISOString(), speaker: 'us', text: '(replaying order) ' + script.text });
        log('respond', 'staff asked to repeat — replaying the order');
        const dur = await playAudio(page, orderAudio);
        await sleep(Math.min(dur * 1000 + 400, 6000));
        continue;
      }
      // A canned reply (key). 'goodbye' also ends the call after speaking.
      transcript.push({ at: new Date().toISOString(), speaker: 'us', text: '(reply: ' + res.key + ')' });
      await speakReply(res.key);
      if (res.action === 'hangup') {
        log('listen', 'staff said goodbye — ending the call');
        ended = true;
      }
    }
    await sleep(200);
  }
  // Drain any trailing audio (staff may have spoken as we timed out).
  if (chunks.length) {
    const text = await transcribeAccumulated();
    if (text) {
      transcript.push({ at: new Date().toISOString(), speaker: 'staff', text });
      log('staff', '(trailing) "' + text + '"');
    }
  }
  log('listen', 'two-way loop ended (turns=' + turns + ', ended=' + ended + ')');
  return { transcript, turns, ended };
}

// ---------- Login / dial (live) ----------
// Code sources: --code, TEXTNOW_CODE env, then Firebase polling
// (parent writes the code to the order node after reading Gmail).
async function getCode(orderId, idToken, directCode) {
  if (directCode) {
    if (!/^\d{6}$/.test(directCode)) throw new Error('--code must be exactly 6 digits');
    return directCode;
  }
  if (process.env.TEXTNOW_CODE && /^\d{6}$/.test(process.env.TEXTNOW_CODE)) return process.env.TEXTNOW_CODE;
  if (!orderId || !idToken) throw new Error('no login code supplied: pass --code, set TEXTNOW_CODE, or run with --order-id so the code can be polled from Firebase');
  log('code', 'waiting for the 6-digit code in Firebase (parent reads Gmail and writes it to the order)…');
  return fb.waitForCode(orderId, idToken, CODE_WAIT_MS);
}

async function enterCode(page, code) {
  const boxes = page.locator(SELECTORS.codeBoxes);
  const boxCount = await boxes.count();
  if (boxCount >= 6) {
    for (let i = 0; i < 6; i++) await boxes.nth(i).fill(code[i], { timeout: 5000 });
    log('code', 'entered 6 digits into ' + boxCount + ' one-digit boxes');
  } else {
    await page.locator(SELECTORS.codeSingle).first().fill(code, { timeout: 15000 });
    log('code', 'entered 6 digits into a single code input');
  }
  await page.locator(SELECTORS.codeSubmit).first().click({ timeout: 15000 }).catch(() => {
    log('code', 'no submit button found — the code may auto-submit');
  });
}

async function isLoggedIn(page) {
  await page.goto(SELECTORS.appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/\/login/i.test(page.url())) return false;
  return (await page.locator(SELECTORS.continueWithEmail).count()) === 0;
}

async function ensureLoggedIn(page, email, orderId, idToken, directCode, onWaitingForCode) {
  if (await isLoggedIn(page)) {
    log('login', 'session restored from the persistent profile — already logged in');
    return;
  }
  log('login', 'not logged in — starting passwordless login for ' + email);
  await page.goto(SELECTORS.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.click(SELECTORS.continueWithEmail, { timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.fill(SELECTORS.email, email, { timeout: 15000 });
  await page.click(SELECTORS.emailContinue, { timeout: 15000 });
  log('login', 'waiting for the code-entry screen…');
  try {
    await page.waitForSelector(SELECTORS.codeInput, { timeout: 30000 });
  } catch (e) {
    await page.screenshot({ path: 'textnow-after-email.png' }).catch(() => {});
    throw new Error('code-entry screen did not appear after the email step (see textnow-after-email.png; current URL: ' + page.url() + ')');
  }
  log('login', 'code-entry screen is showing; TextNow sent a 6-digit code to Gmail');
  if (onWaitingForCode) await onWaitingForCode().catch(() => {});
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await getCode(orderId, idToken, attempt === 1 ? directCode : '');
    await enterCode(page, code);
    await page.waitForTimeout(4000);
    if (/\/messaging/i.test(page.url()) && (await page.locator(SELECTORS.continueWithEmail).count()) === 0) {
      log('login', 'logged in (attempt ' + attempt + '); session saved in the persistent profile');
      return;
    }
    const errShown = (await page.locator(SELECTORS.codeError).count()) > 0;
    log('login', 'code attempt ' + attempt + ' did not log in' + (errShown ? ' (error shown)' : ' (still on code screen)') + ' — waiting for a fresh code');
  }
  throw new Error('login failed after 3 code attempts');
}

// ---------- Dry run ----------
// Phase 1: host WebRTC check. Phase 2: full loop against a simulated
// staff peer (two PeerConnections in-page; peer A plays a staff
// utterance, peer B captures it, Whisper transcribes, the responder
// picks a reply, the reply plays into the fake mic). No TextNow.
async function dryRun(order, script, orderAudio) {
  log('dry-run', 'phase 1 — WebRTC host check');
  const host = await hostCheck();
  const hostOk = host.udpOk && host.twoPeerConnected && host.twoPeerRms > 0.005;
  log('dry-run', 'host check: udp=' + host.udpOk + ' turnRelay=' + host.turnRelay +
    ' twoPeer=' + host.twoPeerConnected + ' rms=' + host.twoPeerRms + ' -> ' + (hostOk ? 'PASS' : 'FAIL'));
  if (!hostOk) {
    return { ok: false, mode: 'dry-run', host, error: 'host WebRTC check failed (udp=' + host.udpOk + ', twoPeer=' + host.twoPeerConnected + ')' };
  }

  log('dry-run', 'phase 2 — simulated staff conversation (two-peer loop)');
  const browser = await chromium.launch(chromiumOpts());
  const result = { ok: false, mode: 'dry-run', host, transcript: [], turns: 0 };
  try {
    const page = await browser.newPage();
    await page.addInitScript(INJECT);
    await page.goto('about:blank');
    // Expose the chunk receiver (same as the live loop).
    const chunks = [];
    await page.exposeFunction('__sendAudioChunk', (dataUrl) => {
      try {
        const b64 = String(dataUrl).split(',')[1] || '';
        const buf = Buffer.from(b64, 'base64');
        if (buf.length) chunks.push(buf);
      } catch (_) {}
    });
    // Build a simulated staff peer: peer A plays a staff utterance
    // (test fixture audio), peer B receives it through the hooked
    // RTCPeerConnection (so inject.js captures + records it).
    const staffFile = path.join(AUDIO_DIR, 'test-staff-everything.mp3');
    if (!fs.existsSync(staffFile)) throw new Error('missing test fixture test-staff-everything.mp3');
    const staffAudio = fs.readFileSync(staffFile);
    const staffB64 = staffAudio.toString('base64');
    const sim = await page.evaluate(async (staffB64) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const hm = window.__hailmary;
      const pcA = new RTCPeerConnection();
      const pcB = new RTCPeerConnection();
      pcA.onicecandidate = (e) => { if (e.candidate) pcB.addIceCandidate(e.candidate).catch(() => {}); };
      pcB.onicecandidate = (e) => { if (e.candidate) pcA.addIceCandidate(e.candidate).catch(() => {}); };
      // Peer B's remote track is captured by inject.js (hook) — the
      // same path a real TextNow call uses.
      pcA.addTrack(hm.mic.getAudioTracks()[0], hm.mic);
      const offer = await pcA.createOffer();
      await pcA.setLocalDescription(offer);
      await pcB.setRemoteDescription(offer);
      const answer = await pcB.createAnswer();
      await pcB.setLocalDescription(answer);
      await pcA.setRemoteDescription(answer);
      const t0 = Date.now();
      let state = '';
      while (Date.now() - t0 < 30000) {
        state = pcA.connectionState + '/' + pcA.iceConnectionState;
        if (pcA.connectionState === 'connected') break;
        await sleep(250);
      }
      if (pcA.connectionState !== 'connected') return { connected: false, state };
      // Play the staff utterance into peer A's mic (so peer B hears it).
      const bytes = Uint8Array.from(atob(staffB64), (c) => c.charCodeAt(0));
      const dur = await hm.sayBuffer(bytes.buffer);
      await sleep(dur * 1000 + 1500);
      const remoteChunks = hm.remoteChunks.length;
      const remoteLevel = hm.remoteLevel();
      return { connected: true, state, playedSec: dur, remoteChunks, remoteLevel };
    }, staffB64);
    log('dry-run', 'sim peer: connected=' + sim.connected + ' state=' + sim.state +
      ' played=' + (sim.playedSec ? sim.playedSec.toFixed(1) + 's' : 'n/a') +
      ' remoteChunks=' + (sim.remoteChunks || 0) + ' remoteLevel=' + (sim.remoteLevel || 0).toFixed(3));
    if (!sim.connected || !(sim.remoteChunks > 0)) {
      result.error = 'simulated staff audio was not captured (connected=' + sim.connected + ', chunks=' + (sim.remoteChunks || 0) + ')';
      return result;
    }
    // Transcribe the captured chunks with Whisper.
    const webm = Buffer.concat(chunks);
    const tmp = path.join(__dirname, 'dryrun-remote.webm');
    fs.writeFileSync(tmp, webm);
    let text = '';
    try { text = await transcribe(tmp); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    log('dry-run', 'Whisper transcribed simulated staff as: "' + text + '"');
    result.transcript.push({ speaker: 'staff', text });
    const res = respond(text, order);
    log('dry-run', 'responder picked: ' + JSON.stringify(res));
    if (res.action === 'none' || !res.key) {
      result.error = 'responder did not pick a reply for the simulated staff line "' + text + '"';
      return result;
    }
    result.transcript.push({ speaker: 'us', text: '(reply: ' + res.key + ')' });
    result.turns = 1;
    // Verify the reply plays into the fake mic with audible level.
    const replyBuf = fs.readFileSync(path.join(AUDIO_DIR, res.key + '.mp3'));
    const playedSec = await playAudio(page, replyBuf);
    let maxLevel = 0;
    const mt0 = Date.now();
    while (Date.now() - mt0 < Math.min(playedSec * 1000, 8000)) {
      const lvl = await page.evaluate(() => window.__hailmary.micLevel());
      if (lvl > maxLevel) maxLevel = lvl;
      await sleep(200);
    }
    log('dry-run', 'reply "' + res.key + '" played into fake mic, max RMS=' + maxLevel.toFixed(4));
    result.ok = maxLevel > 0.005;
    if (!result.ok) result.error = 'reply did not produce audible mic audio (max RMS ' + maxLevel.toFixed(4) + ')';
    return result;
  } finally {
    await browser.close();
  }
}

// ---------- Live call ----------
async function liveCall(order, script, orderAudio, to, orderId, idToken, directCode, onWaitingForCode) {
  const email = process.env.TEXTNOW_EMAIL || DEFAULT_EMAIL;
  const context = await chromium.launchPersistentContext(PROFILE_DIR, chromiumOpts());
  await context.addInitScript(INJECT);
  const page = context.pages()[0] || await context.newPage();
  // Receive remote audio chunks forwarded by inject.js. Exposed BEFORE
  // login/dial so no early staff audio is dropped (the MediaRecorder
  // starts as soon as a remote track is captured on call connect).
  const remoteState = { chunks: [], lastChunkAt: 0 };
  await page.exposeFunction('__sendAudioChunk', (dataUrl) => {
    try {
      const b64 = String(dataUrl).split(',')[1] || '';
      const buf = Buffer.from(b64, 'base64');
      if (buf.length) { remoteState.chunks.push(buf); remoteState.lastChunkAt = Date.now(); }
    } catch (_) { /* drop malformed chunk */ }
  });
  try {
    await ensureLoggedIn(page, email, orderId, idToken, directCode, onWaitingForCode);
    event({ event: 'dialing', to });
    log('dial', 'opening the dialer');
    await page.goto(SELECTORS.appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.locator(SELECTORS.newCallButton).first().click({ timeout: 15000 })
      .catch(() => log('dial', 'no separate new-call button; trying the dial input directly'));
    await page.fill(SELECTORS.dialInput, to, { timeout: 15000 });
    await page.click(SELECTORS.callButton, { timeout: 15000 });
    log('dial', 'calling ' + to + ' …');
    await page.waitForSelector(SELECTORS.inCall, { timeout: 30000 });
    await page.waitForTimeout(2000);
    event({ event: 'playing' });
    log('call', 'call appears connected; playing the order (' + script.language + ')');
    const playedSec = await playAudio(page, orderAudio);
    log('call', 'order played (' + playedSec.toFixed(1) + 's); listening for the staff…');
    const convo = await converse(page, order, orderAudio, script, remoteState);
    await page.locator(SELECTORS.endCallButton).first().click({ timeout: 15000 })
      .catch(() => log('call', 'no end-call button found — the call may already be over'));
    log('call', 'hung up. Done.');
    event({ event: 'done' });
    return { ok: true, mode: 'live', to, language: script.language, room: script.room,
             guest: script.guest, durationSec: +playedSec.toFixed(1), script: script.text,
             transcript: convo.transcript, turns: convo.turns, conversationEnded: convo.ended };
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.live && process.env.HAILMARY_LIVE !== '1') {
    console.error('error: live calls require HAILMARY_LIVE=1 in the environment (safety gate).');
    process.exit(2);
  }
  // Load the order: Firebase by --order-id, or a JSON file.
  let order = null;
  let firebaseOrder = null;
  let idToken = null;
  if (args.orderId) {
    const auth = await fb.auth();
    idToken = auth.idToken;
    firebaseOrder = await fb.readOrder(args.orderId, idToken);
    if (!firebaseOrder) throw new Error('no Firebase order found for id ' + args.orderId);
    order = firebaseOrder;
    log('order', 'loaded order ' + args.orderId + ' from Firebase (room ' + order.room + ', ' + (order.items || []).length + ' items, dryRun=' + order.dryRun + ')');
    if (order.dryRun === false && !args.live) {
      console.log('NOTE: order says dryRun:false but this run is --dry-run; running the dry-run verification only (no live call).');
    }
  } else if (args.order) {
    order = JSON.parse(fs.readFileSync(args.order, 'utf8'));
    firebaseOrder = order;
  } else {
    console.error('usage: node gha-call.js --order-id <firebasePushId> | --order order.json [--order-audio order.mp3] [--code 123456] [--dry-run|--live]');
    process.exit(2);
  }
  if (!order.items || !order.items.length) { console.error('error: order has no items'); process.exit(2); }

  const script = buildScript(order);
  console.log('Script (' + script.language + ', room ' + script.room + ', guest ' + script.guest + '):');
  console.log(script.text);
  if (script.unmapped.length) console.log('NOTE: no Spanish mapping for: ' + script.unmapped.join(', ') + ' (spoken in English)');

  const { audio: orderAudio, source: audioSource } = await resolveOrderAudio(args, order, firebaseOrder);
  console.log('Order audio: ' + audioSource + ' (' + orderAudio.length + ' bytes)');

  let result;
  const onWaitingForCode = (async () => {
    if (args.orderId && idToken) {
      await fb.patchOrder(args.orderId, idToken, { status: 'waiting-for-code' }).catch(() => {});
      log('code', 'marked the Firebase order waiting-for-code (parent reads Gmail and writes the code)');
    }
  });
  if (!args.live) {
    result = await dryRun(order, script, orderAudio);
  } else {
    result = await liveCall(order, script, orderAudio, args.to, args.orderId, idToken, args.code, onWaitingForCode);
    // Report the live result back to Firebase so the order page shows it.
    if (args.orderId && idToken) {
      await fb.patchOrder(args.orderId, idToken, {
        status: result.ok ? 'done' : 'failed',
        result: { ok: result.ok, mode: 'live', language: result.language, durationSec: result.durationSec,
                  script: result.script, transcript: result.transcript, turns: result.turns,
                  conversationEnded: result.conversationEnded, error: result.error || null },
      }).catch((e) => log('firebase', 'could not write result back: ' + e.message));
    }
  }
  if (args.result) fs.writeFileSync(args.result, JSON.stringify(result, null, 2));
  if (args.json) console.log('JSON ' + JSON.stringify(result));
  else console.log('\n' + (result.ok ? 'PASSED' : 'FAILED') + ': ' + (result.error || 'two-way ' + result.mode + ' completed (turns=' + (result.turns || 0) + ')'));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { respond, hostCheck, dryRun, liveCall };
