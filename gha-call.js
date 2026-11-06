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
const http = require('http');
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
// Pipe-source mic (NEW method): the mic is a REAL PulseAudio source
// (module-pipe-source, source_name=virtmic, fed live by the FIFO
// /tmp/virtmic). Node writes raw s16le 48kHz mono PCM into the FIFO;
// Chromium opens virtmic as its mic. This replaces the Vexa remap-source
// approach, which failed because Chromium refuses a .monitor as a mic
// input. Override the FIFO path with PULSE_PIPE_FILE if needed.
const PIPE_PATH = process.env.PULSE_PIPE_FILE || '/tmp/virtmic';
const PIPE_RATE = 48000; // Hz, mono s16le
const PIPE_BYTES_PER_SEC = PIPE_RATE * 2; // 96000 bytes/sec
const PIPE_CHUNK = 9600; // 100 ms of audio
const SILENCE_CHUNK = Buffer.alloc(PIPE_CHUNK); // zeros
// Audio feed, chosen by the workflow from `pactl info` (Server Name):
//  - 'pipe' (default, real PulseAudio): write PCM into the FIFO
//    /tmp/virtmic (module-pipe-source).
//  - 'paplay' (PipeWire): the mic is a pw-loopback source (virtmic)
//    mirroring tts_sink; feed PCM into tts_sink via a paplay process
//    reading raw PCM from stdin. The workflow sets MIC_FEED in
//    GITHUB_ENV based on the detected server.
const MIC_FEED = process.env.MIC_FEED || 'pipe';
const PAPLAY_SINK = process.env.PULSE_TTS_SINK || 'tts_sink';
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

// Serves a blank page over HTTP on 127.0.0.1 and returns { url, close }.
// Needed because navigator.mediaDevices only exists in a secure context,
// and about:blank is NOT one (localhost is). Both hostCheck and the
// dry-run two-peer sim need a real getUserMedia mic, so they must load
// from this local page instead of about:blank.
async function serveBlankPage() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>blank</title></head><body></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  return { url, close: () => { try { server.close(); } catch (_) {} } };
}

// ---------- PulseAudio pipe-source mic (NEW method) ----------
// The mic is a REAL PulseAudio source: module-pipe-source creates the
// FIFO /tmp/virtmic (the module creates it — do NOT mkfifo it first).
// Node opens the FIFO for writing ONCE and keeps it open for the whole
// run, writing silence when idle (a closed writer suspends the source)
// and raw s16le 48kHz mono PCM when speaking. Chromium opens virtmic
// as its real mic (selected explicitly by deviceId). No paplay, no
// tts_sink, no Web Audio fake mic anywhere.
const { execFile, spawn } = require('child_process');
const os = require('os');

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = execFile(cmd, args, { timeout: timeoutMs || 60000, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      if (err) return reject(new Error(cmd + ' failed: ' + (stderr || err.message).slice(0, 300)));
      resolve({ stdout, stderr });
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
  });
}

// --- Pipe writer (singleton, kept open for the whole run) ---
const pipeState = { stream: null, proc: null, opening: null, keepaliveOn: false, speaking: false, keepaliveBusy: false };

function pipeOpenStream() {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(PIPE_PATH, { flags: 'w' });
    const to = setTimeout(() => { try { stream.destroy(); } catch (_) {} reject(new Error('timed out opening ' + PIPE_PATH + ' (is module-pipe-source loaded?)')); }, 15000);
    stream.once('open', () => { clearTimeout(to); resolve(stream); });
    stream.once('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// Open the audio feed for writing (once per process) and start the
// silence keepalive. Two feeds, chosen by MIC_FEED env (set by the
// workflow from `pactl info`):
//  - 'pipe' (default, real PulseAudio): the FIFO /tmp/virtmic, created
//    by module-pipe-source. Retries while the module creates the FIFO.
//  - 'paplay' (PipeWire): a paplay process reading raw s16le 48kHz mono
//    PCM from stdin and playing it into tts_sink, which pw-loopback
//    mirrors as the virtmic source. Same byte-stream contract as the
//    FIFO (silence keepalive + speech PCM), so pipeWrite/keepalive/
//    playPipePcm work unchanged — pipeState.stream is either the FIFO
//    stream or paplay's stdin. The writer stays open until the process
//    exits; closing it suspends the source, so never close it mid-run.
async function ensurePipe() {
  if (pipeState.stream) return pipeState.stream;
  if (pipeState.opening) return pipeState.opening;
  pipeState.opening = (async () => {
    if (MIC_FEED === 'paplay') {
      const proc = spawn('paplay', ['--device=' + PAPLAY_SINK, '--raw', '--format=s16le', '--rate=' + String(PIPE_RATE), '--channels=1'], { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.on('error', (e) => { log('pipe', 'paplay spawn error: ' + e.message); });
      proc.on('exit', (code) => { log('pipe', 'paplay exited code=' + code + ' (feed is dead)'); });
      pipeState.stream = proc.stdin;
      pipeState.proc = proc;
      log('pipe', 'paplay feed open (stdin -> ' + PAPLAY_SINK + ', s16le 48kHz mono)');
      startPipeKeepalive();
      return proc.stdin;
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const stream = await pipeOpenStream();
        pipeState.stream = stream;
        stream.on('error', (e) => { log('pipe', 'write stream error: ' + e.message); });
        log('pipe', 'opened ' + PIPE_PATH + ' for writing (s16le 48kHz mono)');
        startPipeKeepalive();
        return stream;
      } catch (e) {
        lastErr = e;
        if (/ENOENT/.test(e.message || '')) { await sleep(500); continue; }
        throw e;
      }
    }
    throw new Error('could not open pipe ' + PIPE_PATH + ': ' + (lastErr && lastErr.message));
  })();
  return pipeState.opening;
}

// Write a buffer to the pipe. Rejects on a 10 s stall so a dead reader
// fails fast instead of hanging the call.
function pipeWrite(buf) {
  const stream = pipeState.stream;
  if (!stream) return Promise.reject(new Error('pipe not open'));
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => {
      if (!done) { done = true; reject(new Error('pipe write stalled 10s (feed=' + MIC_FEED + ': is the reader draining ' + (MIC_FEED === 'paplay' ? 'paplay stdin' : PIPE_PATH) + '?)')); }
    }, 10000);
    const onErr = (e) => { if (!done) { done = true; clearTimeout(to); reject(e); } };
    stream.once('error', onErr);
    stream.write(buf, (err) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      stream.removeListener('error', onErr);
      err ? reject(err) : resolve();
    });
  });
}

// Background loop: while idle, feed 100 ms silence chunks at ~real-time
// rate so the pipe-source never starves or suspends. Skips while
// speaking (speech writes its own chunks) and while a write is in flight.
async function pipeKeepaliveLoop() {
  while (pipeState.keepaliveOn) {
    if (!pipeState.speaking && !pipeState.keepaliveBusy && pipeState.stream) {
      pipeState.keepaliveBusy = true;
      try { await pipeWrite(SILENCE_CHUNK); } catch (e) { log('pipe', 'keepalive write failed: ' + e.message); }
      pipeState.keepaliveBusy = false;
    }
    await sleep(90);
  }
}

function startPipeKeepalive() {
  if (pipeState.keepaliveOn) return;
  pipeState.keepaliveOn = true;
  pipeKeepaliveLoop().catch(() => {});
}

// Decode an MP3 buffer to raw s16le 48kHz mono PCM. Returns { pcm, seconds }.
async function mp3ToPcm(mp3Buf) {
  const tag = 'hailmary-play-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const tmpMp3 = path.join(os.tmpdir(), tag + '.mp3');
  const tmpRaw = path.join(os.tmpdir(), tag + '.raw');
  fs.writeFileSync(tmpMp3, mp3Buf);
  try {
    await runCmd('ffmpeg', ['-y', '-v', 'error', '-i', tmpMp3, '-ac', '1', '-ar', String(PIPE_RATE), '-f', 's16le', tmpRaw], 60000);
    if (!fs.existsSync(tmpRaw) || fs.statSync(tmpRaw).size < 100) throw new Error('ffmpeg produced no usable PCM');
    const pcm = fs.readFileSync(tmpRaw);
    return { pcm, seconds: pcm.length / PIPE_BYTES_PER_SEC };
  } finally {
    try { fs.unlinkSync(tmpMp3); } catch (_) {}
    try { fs.unlinkSync(tmpRaw); } catch (_) {}
  }
}

// Write raw PCM into the pipe at ~real-time rate (100 ms chunks).
// Awaits playback completion. Returns the duration in seconds.
async function playPipePcm(pcm) {
  await ensurePipe();
  pipeState.speaking = true;
  try {
    const total = Math.ceil(pcm.length / PIPE_CHUNK);
    for (let i = 0; i < total; i++) {
      const chunk = pcm.subarray(i * PIPE_CHUNK, Math.min(pcm.length, (i + 1) * PIPE_CHUNK));
      const t0 = Date.now();
      await pipeWrite(chunk);
      const elapsed = Date.now() - t0;
      if (elapsed < 90) await sleep(90 - elapsed);
    }
    return pcm.length / PIPE_BYTES_PER_SEC;
  } finally {
    pipeState.speaking = false;
  }
}

// Generate a sine tone as raw PCM and play it into the pipe.
// Awaits playback completion. Returns the duration in seconds.
async function playTonePipe(freq, seconds) {
  const total = Math.floor(seconds * PIPE_RATE);
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const v = Math.round(16383 * Math.sin((2 * Math.PI * freq * i) / PIPE_RATE));
    pcm.writeInt16LE(v, i * 2);
  }
  return playPipePcm(pcm);
}

// ---------- Audio diagnostics (so the next failure is diagnosable) ----------
// Run a command, return stdout ('' on failure). Used for pactl/parec
// probes so the CI log shows the sound-server state.
async function shOut(cmd, args, timeoutMs) {
  try {
    const { stdout } = await runCmd(cmd, args, timeoutMs || 15000);
    return stdout || '';
  } catch (e) { return ''; }
}

// Condense `pactl list sources` to one line per source: name + state.
function summarizePactlSources(text) {
  const lines = [];
  for (const b of String(text || '').split(/\n\s*\n/)) {
    const name = (b.match(/Name:\s*(\S+)/) || [])[1];
    const state = (b.match(/State:\s*(\S+)/) || [])[1];
    if (name) lines.push(name + ':' + (state || '?'));
  }
  return lines.join(' | ') || '(none)';
}

// Condense `pactl list source-outputs` to one line per output: id,
// source, and the owning application (Chromium when it is recording).
function summarizeSourceOutputs(text) {
  const lines = [];
  for (const b of String(text || '').split(/\n\s*\n/)) {
    const id = (b.match(/Source Output #(\d+)/) || [])[1];
    const src = (b.match(/Source:\s*(\S+)/) || [])[1];
    const app = (b.match(/application\.name\s*=\s*"([^"]*)"/) || [])[1];
    if (id) lines.push('#' + id + ' src=' + (src || '?') + ' app=' + (app || '?'));
  }
  return lines.join(' | ') || '(none)';
}

// Log the audio state during the call: whether Chromium has a recording
// stream on virtmic, and whether virtmic is RUNNING (reading) or IDLE
// (stub — never reads the FIFO). Call before/after the tone.
async function logAudioState(tag) {
  const so = await shOut('pactl', ['list', 'source-outputs']);
  log('host', tag + ' source-outputs: ' + summarizeSourceOutputs(so));
  const src = await shOut('pactl', ['list', 'sources']);
  log('host', tag + ' sources: ' + summarizePactlSources(src));
}

// Record the mic source (virtmic) to a WAV file for N seconds, in the
// background. Resolves when the recording is done. This proves whether
// virtmic itself carries audio, independent of Chromium/WebRTC: if the
// parec WAV has the tone, the feed works and the problem is
// Chromium/WebRTC; if silent, the feed (FIFO/paplay) -> virtmic is
// broken. parec attaching also wakes an IDLE source, which is fine —
// it reads a copy, it does not steal audio from Chromium.
function recordMicWav(device, seconds, outFile) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    let child;
    try {
      child = spawn('parec', ['--device=' + device, '--file-format=wav', outFile]);
    } catch (e) { finish(); return; }
    child.on('error', finish);
    child.on('exit', finish);
    setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, seconds * 1000);
  });
}

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
    // --use-fake-ui-for-media-stream auto-accepts the mic permission
    // prompt. NEVER add --use-fake-device-for-media-stream (it bypasses
    // PulseAudio entirely, so the pipe-source mic is never used) or
    // --use-file-for-fake-audio-capture (forces silence as mic input).
    // Those two flags break the pipe-source mic (see inject.js).
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--no-sandbox', '--disable-dev-shm-usage'].concat(extraArgs || []),
  };
  // On GitHub Actions Playwright installs its own Chromium; on this VM
  // the path is fixed. Honour an explicit path when set.
  if (process.env.PLAYWRIGHT_CHROME_PATH) opts.executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  return opts;
}

// ---------- WebRTC host check (dry-run phase 1) ----------
// Returns { udpOk, turnRelay, twoPeerConnected, twoPeerRms, micLabel, recvDb, recvBytes }.
// UDP: direct socket send to loopback + to a public STUN host.
// TURN: ICE gathering against openrelay.metered.ca (TCP/TLS).
// Two-peer: two RTCPeerConnections in-page; peer A uses the REAL
// pipe-source mic (virtmic), a tone is written into the pipe, and peer
// B's received audio is measured with MediaRecorder (decoded + ffmpeg
// volumedetect). This tests the pipe-source mic path — the old Vexa
// remap-source mic was always silent here (Chromium refuses a .monitor
// as a mic input).
async function hostCheck() {
  const out = { udpOk: false, turnRelay: false, twoPeerConnected: false, twoPeerRms: 0, micLabel: '', recvDb: null, recvBytes: 0, micRecDb: null, micRecRms: 0 };
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

  // Open the pipe BEFORE launching Chromium so the pipe-source is live
  // (fed with silence) when Chromium opens the mic.
  try { await ensurePipe(); } catch (e) { log('host', 'pipe open failed: ' + e.message); }

  const browser = await chromium.launch(chromiumOpts(['--disable-features=WebRtcHideLocalIpsWithMdns']));
  let blank = null;
  try {
    const page = await browser.newPage();
    await page.addInitScript(INJECT);
    // about:blank is not a secure context (no navigator.mediaDevices),
    // so serve a blank page from localhost instead.
    blank = await serveBlankPage();
    await page.goto(blank.url);
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
      // UDP path exists — try two peers over host/srflx, using the REAL
      // pipe-source mic (virtmic). A tone is written into the pipe and
      // must arrive at the remote peer; the remote side is measured
      // with MediaRecorder (not a Web Audio Analyser).
      const setup = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let micInfo = null;
        let micStream = null;
        // Labels are only revealed after permission, so get a temp
        // stream first, enumerate, then open virtmic EXPLICITLY by
        // deviceId (the default device has an empty label by design and
        // may not be virtmic). APM off: it can gate non-speech audio.
        const apmOff = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        try {
          const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
          let virtId = '';
          let devList = [];
          try {
            const devs = await navigator.mediaDevices.enumerateDevices();
            devList = devs.filter((d) => d.kind === 'audioinput').map((d) => ({ label: d.label || '', deviceId: (d.deviceId || '').slice(0, 12) }));
            const virt = devs.find((d) => d.kind === 'audioinput' && /virtmic/i.test(d.label || ''));
            if (virt) virtId = virt.deviceId;
          } catch (e) { /* enumerate failed; fall back to default */ }
          tmp.getTracks().forEach((t) => t.stop());
          if (virtId) {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: virtId } }, apmOff) });
          } else {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: apmOff });
          }
          const track = micStream.getAudioTracks()[0];
          micInfo = { label: track.label || '', deviceId: (track.getSettings().deviceId || '').slice(0, 12), readyState: track.readyState, enabled: track.enabled, virtmicFound: !!virtId, devices: devList };
        } catch (e) {
          return { ok: false, micError: String(e), micInfo: null };
        }
        const pcA = new RTCPeerConnection();
        const pcB = new RTCPeerConnection();
        pcA.onicecandidate = (e) => { if (e.candidate) pcB.addIceCandidate(e.candidate).catch(() => {}); };
        pcB.onicecandidate = (e) => { if (e.candidate) pcA.addIceCandidate(e.candidate).catch(() => {}); };
        let recResolve = null;
        const recDone = new Promise((res) => { recResolve = res; });
        const rec = { chunks: [], recorder: null, done: recDone, resolve: recResolve };
        pcB.ontrack = (ev) => {
          const rtrack = ev.track;
          try {
            const r = new MediaRecorder(new MediaStream([rtrack]));
            r.ondataavailable = (e2) => { if (e2.data && e2.data.size) rec.chunks.push(e2.data); };
            r.onstop = () => rec.resolve();
            r.start(250);
            rec.recorder = r;
          } catch (e) { rec.resolve(); }
        };
        window.__hostRec = rec;
        pcA.addTrack(micStream.getAudioTracks()[0], micStream);
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
        return { ok: pcA.connectionState === 'connected', state, micInfo };
      });
      log('host', 'two-peer setup: connected=' + setup.ok + ' state=' + (setup.state || '?') +
        ' mic=' + (setup.micInfo ? JSON.stringify(setup.micInfo) : 'none') +
        (setup.micError ? ' micError=' + setup.micError : ''));
      out.micLabel = setup.micInfo ? setup.micInfo.label : '';
      out.twoPeerConnected = !!setup.ok;
      if (setup.ok) {
        // Diagnostics: is Chromium actually recording from virtmic, and
        // is virtmic RUNNING (reading) or IDLE (stub)? Log before tone.
        await logAudioState('pre-tone');
        // Record virtmic directly with parec (proves whether the mic
        // source itself carries audio, independent of WebRTC). Runs
        // concurrently with the tone below.
        const micWav = path.join(os.tmpdir(), 'hostcheck-mic-' + Date.now() + '.wav');
        const micRecP = recordMicWav('virtmic', 3, micWav);
        // Write a 6s tone into the feed while the remote peer records.
        // A stalled write (PulseAudio not reading) must not abort the
        // diagnostics below — log it and continue to measure.
        try { await playTonePipe(880, 6); } catch (e) { log('host', 'tone write failed: ' + e.message); }
        await sleep(800); // let the last recorder slice flush
        await logAudioState('post-tone');
        await micRecP;
        // Measure the parec recording: if virtmic has the tone, the feed
        // works and the problem is Chromium/WebRTC; if silent, the feed
        // (FIFO/paplay) -> virtmic is broken.
        try {
          if (fs.existsSync(micWav) && fs.statSync(micWav).size > 100) {
            const mvol = await measureVolumeDb(micWav);
            out.micRecDb = mvol.meanDb;
            out.micRecRms = +mvol.linear.toFixed(4);
            log('host', 'mic parec: bytes=' + fs.statSync(micWav).size + ' meanDb=' +
              (mvol.meanDb === null || mvol.meanDb === undefined ? 'n/a' : (mvol.meanDb === -Infinity ? '-inf' : mvol.meanDb)) +
              ' rms=' + out.micRecRms.toFixed(4));
          } else {
            log('host', 'mic parec: no recording captured (file missing/empty)');
          }
        } catch (e) { log('host', 'mic parec measure failed: ' + e.message); }
        finally { try { fs.unlinkSync(micWav); } catch (_) {} }
        const captured = await page.evaluate(async () => {
          const rec = window.__hostRec;
          if (!rec || !rec.recorder) return { chunksB64: [], totalBytes: 0, chunkCount: 0 };
          if (rec.recorder.state !== 'inactive') {
            rec.recorder.stop();
            await rec.done;
          }
          const bufs = [];
          let total = 0;
          for (const b of rec.chunks) {
            const ab = await b.arrayBuffer();
            bufs.push(Buffer.from(ab).toString('base64'));
            total += b.size;
          }
          return { chunksB64: bufs, totalBytes: total, chunkCount: rec.chunks.length };
        });
        out.recvBytes = captured.totalBytes;
        log('host', 'remote captured: chunks=' + captured.chunkCount + ' bytes=' + captured.totalBytes);
        if (captured.totalBytes > 0) {
          const webm = Buffer.concat(captured.chunksB64.map((b) => Buffer.from(b, 'base64')));
          const tmpWebm = path.join(os.tmpdir(), 'hostcheck-remote-' + Date.now() + '.webm');
          fs.writeFileSync(tmpWebm, webm);
          try {
            const vol = await measureVolumeDb(tmpWebm);
            out.recvDb = vol.meanDb;
            out.twoPeerRms = +vol.linear.toFixed(4);
          } finally {
            try { fs.unlinkSync(tmpWebm); } catch (_) {}
          }
        }
        log('host', 'two-peer: state=' + setup.state + ' mic=' + (out.micLabel || '?') +
          ' recvBytes=' + out.recvBytes + ' meanDb=' +
          (out.recvDb === null || out.recvDb === undefined ? 'n/a' : (out.recvDb === -Infinity ? '-inf' : out.recvDb)) +
          ' recvRMS=' + out.twoPeerRms.toFixed(4) +
          ' micRecDb=' + (out.micRecDb === null || out.micRecDb === undefined ? 'n/a' : (out.micRecDb === -Infinity ? '-inf' : out.micRecDb)) +
          ' micRecRMS=' + out.micRecRms.toFixed(4));
      }
    }
  } finally {
    if (blank) blank.close();
    await browser.close();
  }
  return out;
}

// ---------- Audio helpers ----------
// Play an MP3 buffer through the pipe-source mic (the mic hears it).
// Returns duration in seconds. The page argument is unused — playback
// is Node-side pipe writes, not Web Audio — but the signature is kept
// so callers don't change.
async function playAudio(page, audioBuf) {
  const { pcm, seconds } = await mp3ToPcm(audioBuf);
  await playPipePcm(pcm);
  return seconds;
}

// Synthesize the order script with espeak-ng (last-resort fallback when
// no Chatty Porch audio was supplied). Robotic — the parent should supply
// Chatty Porch audio for the real call. Returns an MP3 Buffer, or null.
async function espeakSynthesize(text) {
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
  // Fallback speech detection: the remote Analyser can read 0 in headless
  // Chrome even when audio flows, but MediaRecorder chunks for speech are
  // much larger than silence frames. Track chunk growth alongside level.
  let prevChunkCount = 0;
  while (Date.now() - t0 < CONVERSATION_TIMEOUT_MS && !ended) {
    const level = await page.evaluate(() => {
      try { return window.__hailmary.remoteLevel(); } catch (_) { return 0; }
    }).catch(() => 0);
    let chunkSpeech = false;
    if (chunks.length > prevChunkCount) {
      prevChunkCount = chunks.length;
      const last = chunks[chunks.length - 1];
      if (last && last.length > 150) chunkSpeech = true;
    }
    const now = Date.now();
    if (level > REMOTE_LEVEL_THRESHOLD || chunkSpeech) {
      if (!speaking) { speaking = true; log('listen', 'staff speaking (level ' + level.toFixed(3) + (chunkSpeech ? ', chunk' : '') + ')'); }
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
// utterance through the pipe-source mic, peer B captures it,
// Whisper transcribes, the responder picks a reply, the reply plays
// back through the mic). No TextNow.
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
  await ensurePipe(); // pipe already open from hostCheck; no-op if so
  const browser = await chromium.launch(chromiumOpts());
  const result = { ok: false, mode: 'dry-run', host, transcript: [], turns: 0 };
  let blank = null;
  try {
    const page = await browser.newPage();
    await page.addInitScript(INJECT);
    // about:blank is not a secure context (no navigator.mediaDevices),
    // so serve a blank page from localhost instead.
    blank = await serveBlankPage();
    await page.goto(blank.url);
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
    const sim = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let micLabel = '';
      let micStream = null;
      // Open virtmic EXPLICITLY by deviceId (see hostCheck for why).
      const apmOff = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        let virtId = '';
        try {
          const devs = await navigator.mediaDevices.enumerateDevices();
          const virt = devs.find((d) => d.kind === 'audioinput' && /virtmic/i.test(d.label || ''));
          if (virt) virtId = virt.deviceId;
        } catch (e) { /* fall back to default */ }
        tmp.getTracks().forEach((t) => t.stop());
        micStream = virtId
          ? await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: virtId } }, apmOff) })
          : await navigator.mediaDevices.getUserMedia({ audio: apmOff });
        micLabel = micStream.getAudioTracks()[0].label || '';
      } catch (e) {
        return { connected: false, state: 'gum-failed: ' + e, micLabel };
      }
      const pcA = new RTCPeerConnection();
      const pcB = new RTCPeerConnection();
      pcA.onicecandidate = (e) => { if (e.candidate) pcB.addIceCandidate(e.candidate).catch(() => {}); };
      pcB.onicecandidate = (e) => { if (e.candidate) pcA.addIceCandidate(e.candidate).catch(() => {}); };
      pcA.addTrack(micStream.getAudioTracks()[0], micStream);
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
      return { connected: pcA.connectionState === 'connected', state, micLabel };
    });
    log('dry-run', 'sim peer: connected=' + sim.connected + ' state=' + sim.state + ' mic=' + (sim.micLabel || '?'));
    if (!sim.connected) {
      result.error = 'simulated peer did not connect (state=' + sim.state + ')';
      return result;
    }
    // Play the staff utterance into the pipe-source mic.
    const staffDur = await playAudio(page, staffAudio);
    await sleep(1500); // let the last recorder slice + forwarding flush
    const staffBytes = chunks.reduce((n, b) => n + b.length, 0);
    log('dry-run', 'staff fixture played (' + staffDur.toFixed(1) + 's); peer B captured chunks=' + chunks.length + ' bytes=' + staffBytes);
    if (!(chunks.length > 0 && staffBytes > 1000)) {
      result.error = 'simulated staff audio was not captured (chunks=' + chunks.length + ', bytes=' + staffBytes + ')';
      return result;
    }
    // Transcribe the captured chunks with Whisper.
    const webm = Buffer.concat(chunks);
    chunks.length = 0; // reset for the reply capture below
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
    // Verify the reply actually flows through the mic to the peer:
    // play it into the pipe and check peer B captures new audio.
    const replyBuf = fs.readFileSync(path.join(AUDIO_DIR, res.key + '.mp3'));
    const playedSec = await playAudio(page, replyBuf);
    await sleep(1500);
    const replyBytes = chunks.reduce((n, b) => n + b.length, 0);
    log('dry-run', 'reply "' + res.key + '" played (' + playedSec.toFixed(1) + 's); peer B captured chunks=' + chunks.length + ' bytes=' + replyBytes);
    result.ok = chunks.length > 0 && replyBytes > 1000;
    if (!result.ok) result.error = 'reply was not captured by the peer (chunks=' + chunks.length + ', bytes=' + replyBytes + ')';
    return result;
  } finally {
    if (blank) blank.close();
    await browser.close();
  }
}

// ---------- Live call ----------
async function liveCall(order, script, orderAudio, to, orderId, idToken, directCode, onWaitingForCode) {
  const email = process.env.TEXTNOW_EMAIL || DEFAULT_EMAIL;
  // Open the pipe BEFORE launching Chromium so the pipe-source is live
  // (fed with silence) when TextNow opens the mic.
  await ensurePipe();
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
