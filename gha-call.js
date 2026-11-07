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
const os = require('os');
const { chromium, firefox } = require('playwright');
const { buildScript } = require('./script');
const { respond } = require('./respond');
const { transcribe } = require('./whisper');
const fb = require('./firebase');

const INJECT = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
const DEFAULT_TO = '+529988728500'; // Excellence Riviera Cancun front desk
const DEFAULT_EMAIL = 'cgd2049+textnow@gmail.com';
const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const FIREFOX_PROFILE_DIR = path.join(__dirname, '.browser-profile-firefox'); // separate: a Chrome profile dir is not a Firefox profile
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
// Mic mode (MIC_MODE env, set by the workflow):
//  - 'pipe' (default): live/dynamic mic — PulseAudio pipe-source or
//    pw-loopback, fed by Node writing PCM. ONLY mode that supports
//    live replies during a call.
//  - 'fake-file': Chromium's built-in --use-file-for-fake-audio-capture.
//    A REAL WAV file (mono 48kHz s16) is the mic; Chromium loads it
//    whole at first capture and loops it (or plays once with %noloop).
//    Needs NO PulseAudio at all — it bypasses the sound server
//    entirely. This is the ONLY method with verified end-to-end WebRTC
//    audio flow in real browsers (Semaphore LiveKit 16/16 E2E).
//    LIMIT: the file is fixed at Chromium launch — live/dynamic TTS
//    mid-call is IMPOSSIBLE. For a call, the WAV is the ORDER audio
//    (one-shot); staff replies cannot be answered with new audio.
//    A FIFO does NOT work here (Chromium ReadWavFile does GetLength +
//    one whole-file read; a FIFO has length -1 -> silence). The file
//    MUST be a real file on disk.
const MIC_MODE = process.env.MIC_MODE || 'pipe';
// BROWSER: 'chromium' (default, Playwright bundled), 'chrome' (Google
// Chrome stable via PLAYWRIGHT_CHROME_PATH), or 'firefox' (Playwright
// Firefox; fake-file = generated-tone fake stream, pipe = real
// PulseAudio virtmic). Firefox + pipe is the PROVEN call path: runs
// #20 (fake-file) and #22 (pipe) both PASSED the host check, while
// Chromium-family runs #10-#16 decoded silence at the remote peer
// (mic track carries the tone, bytes flow, remote hears nothing).
const BROWSER = (process.env.BROWSER || 'chromium').toLowerCase();
const IS_FIREFOX = BROWSER === 'firefox';
// Fake-mic path: Chromium fake-file flag OR Firefox fake-stream pref.
// Both give the mic track a tone with no sound server.
// Fake mic = MIC_MODE=fake-file only. Firefox in pipe mode uses the REAL
// PulseAudio virtmic (like Chromium pipe); Firefox in fake-file mode uses
// the generated-tone fake stream. (Run #20 proved Firefox's WebRTC receive
// works; pipe is the only mic that can carry the real order audio, so the
// real call needs Firefox + pipe.)
const IS_FAKE_MIC = MIC_MODE === 'fake-file';
const FAKE_MIC_WAV = process.env.FAKE_MIC_WAV || path.join(os.tmpdir(), 'fake-mic.wav');
// Set FAKE_MIC_NOLOOP=1 (env, read at Chromium launch) to append
// %noloop to the fake-file flag (play once, then silence) — used for
// the live one-shot order call. Tests loop the file (default) so audio
// is always present.
// Duration (seconds) of the fake-file mic WAV, set when it is generated
// (used by playAudio in fake-file mode to report how long the order is).
let fakeMicWavSeconds = 0;
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

// ---------- Fake-file mic (MIC_MODE=fake-file) ----------
// Generate a REAL WAV file (mono 48kHz s16) containing a sine tone, at
// outPath. Used by MIC_MODE=fake-file as Chromium's mic (host test).
// Must be a REAL file on disk — Chromium reads the whole file into
// memory at first capture; a FIFO has no length and yields silence.
// The tone is 60s at FULL SCALE (aevalsrc, mean ~-3 dB): ffmpeg's
// `sine` lavfi source is quiet (mean ~-21 dB), and a 10s tone was too
// short — the file starts playing when Chromium launches, so a 10s tone
// is over before the ~6s record window (~27s after launch). 60s covers
// the whole test even if it plays once and never loops. Returns
// { path, seconds } and records the duration in fakeMicWavSeconds.
async function makeFakeMicToneWav(freq, seconds, outPath) {
  await runCmd('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='sin(2*PI*" + freq + "*t)':s=48000:d=" + seconds,
    '-ac', '1', '-ar', '48000', outPath], 60000);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 100) throw new Error('ffmpeg produced no usable fake-mic WAV');
  const secs = Math.max(0, (fs.statSync(outPath).size - 44) / (48000 * 2));
  fakeMicWavSeconds = secs;
  log('fake-file', 'tone WAV ' + outPath + ' (' + secs.toFixed(1) + 's, mono 48kHz s16)');
  // Runner-side verification: confirm the WAV itself is loud, so a
  // silent remote is a Chromium-delivery problem, not a WAV problem.
  try {
    const v = await measureVolumeDb(outPath);
    log('fake-file', 'tone WAV rms=' + (v.linear === 0 ? '0.0000' : v.linear.toFixed(4)) +
      ' meanDb=' + (v.meanDb === null || v.meanDb === undefined ? 'n/a' : v.meanDb));
    if (v.meanDb === null || v.meanDb <= -40) {
      log('fake-file', 'WARNING: tone WAV is silent/quiet (meanDb=' + v.meanDb + ') — the remote will hear nothing');
    }
  } catch (e) { log('fake-file', 'tone WAV measure failed: ' + e.message); }
  return { path: outPath, seconds: secs };
}

// Convert an MP3 buffer to a REAL WAV file (mono 48kHz s16) at outPath.
// Used by MIC_MODE=fake-file call mode: the ORDER audio becomes the mic
// WAV. Returns { path, seconds } and records the duration in
// fakeMicWavSeconds. The WAV is the whole order (greeting + items +
// closing); Chromium plays it (once with %noloop, else looping).
async function mp3ToWavFile(mp3Buf, outPath) {
  const tag = 'hailmary-fake-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const tmpMp3 = path.join(os.tmpdir(), tag + '.mp3');
  fs.writeFileSync(tmpMp3, mp3Buf);
  try {
    await runCmd('ffmpeg', ['-y', '-v', 'error', '-i', tmpMp3, '-ac', '1', '-ar', '48000', outPath], 60000);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 100) throw new Error('ffmpeg produced no usable WAV');
    const secs = Math.max(0, (fs.statSync(outPath).size - 44) / (48000 * 2));
    fakeMicWavSeconds = secs;
    log('fake-file', 'order WAV ' + outPath + ' (' + secs.toFixed(1) + 's, mono 48kHz s16)');
    return { path: outPath, seconds: secs };
  } finally {
    try { fs.unlinkSync(tmpMp3); } catch (_) {}
  }
}

// The --use-file-for-fake-audio-capture flag value for the current mode:
// the WAV path, plus %noloop when FAKE_MIC_NOLOOP=1 (live one-shot
// order: play once, then silence). Reads process.env at call time so
// liveCall can enable %noloop just before launching Chromium. Empty
// string when not fake-file mode.
function fakeFileFlagValue() {
  if (MIC_MODE !== 'fake-file') return '';
  return FAKE_MIC_WAV + (process.env.FAKE_MIC_NOLOOP === '1' ? '%noloop' : '');
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

// Measure a recorded audio file's loudness with ffmpeg volumedetect.
// Returns { meanDb, linear } where linear = 10^(meanDb/20) (0..1 RMS-ish).
// Silent/empty audio yields meanDb -Infinity and linear 0. Never throws:
// on any ffmpeg/parse failure it returns { meanDb: null, linear: 0 }.
async function measureVolumeDb(file) {
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => { err && !stderr ? reject(err) : resolve(String(stderr || '') + String(stdout || '')); });
    });
    const m = out.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    if (!m) return { meanDb: null, linear: 0 };
    const meanDb = parseFloat(m[1]);
    const linear = (meanDb === -Infinity || meanDb <= -91) ? 0 : Math.pow(10, meanDb / 20);
    return { meanDb, linear };
  } catch (e) {
    return { meanDb: null, linear: 0 };
  }
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

// ---------- Web Audio PCM receive capture ----------
// The page (inject.js) forwards raw Float32 PCM samples of the remote
// track via window.__sendAudioPcm(base64, sampleRate). Node accumulates
// them per remoteState and can (a) compute RMS, (b) write them as a
// 16kHz mono WAV for whisper (no WebM/ffmpeg conversion needed).
// This is the PRIMARY receive path — MediaRecorder can be blind in
// headless Chromium (0 chunks even when RTP flows, run #11 proved it:
// bytesSent=bytesReceived=25087 but MediaRecorder captured 0 chunks).
// The WebM/MediaRecorder path is kept as a fallback.
function newRemoteState() {
  return { chunks: [], lastChunkAt: 0, pcmChunks: [], pcmSampleRate: 48000, lastPcmAt: 0, lastPcmSpeechAt: 0, lastPcmRms: 0, pcmSamples: 0 };
}
async function exposeRemoteReceivers(page, remoteState) {
  await page.exposeFunction('__sendAudioChunk', (dataUrl) => {
    try {
      const b64 = String(dataUrl).split(',')[1] || '';
      const buf = Buffer.from(b64, 'base64');
      if (buf.length) { remoteState.chunks.push(buf); remoteState.lastChunkAt = Date.now(); }
    } catch (_) { /* drop malformed chunk */ }
  });
  await page.exposeFunction('__sendAudioPcm', (b64, sampleRate) => {
    try {
      const buf = Buffer.from(String(b64 || ''), 'base64');
      const n = Math.floor(buf.length / 4) * 4;
      if (n < 4) return;
      // Slice to a fresh, aligned ArrayBuffer (Buffer pools are not
      // 4-byte aligned, so a direct Float32Array view can throw).
      const copy = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n));
      let sum = 0;
      for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
      const rms = copy.length ? Math.sqrt(sum / copy.length) : 0;
      remoteState.pcmChunks.push(copy);
      remoteState.pcmSamples += copy.length;
      if (sampleRate) remoteState.pcmSampleRate = sampleRate;
      remoteState.lastPcmAt = Date.now();
      remoteState.lastPcmRms = rms;
      if (rms > REMOTE_LEVEL_THRESHOLD) remoteState.lastPcmSpeechAt = Date.now();
    } catch (_) { /* drop malformed batch */ }
  });
}
// RMS over all accumulated PCM samples (does NOT clear the buffer).
function pcmStateRms(state) {
  if (!state.pcmSamples) return 0;
  let sum = 0;
  for (const c of state.pcmChunks) for (let i = 0; i < c.length; i++) sum += c[i] * c[i];
  return Math.sqrt(sum / state.pcmSamples);
}
// Concatenate all accumulated PCM samples and clear the buffer.
function takePcm(state) {
  const all = new Float32Array(state.pcmSamples);
  let off = 0;
  for (const c of state.pcmChunks) { all.set(c, off); off += c.length; }
  state.pcmChunks = [];
  state.pcmSamples = 0;
  return all;
}
// Write Float32 samples (native rate) as a standard s16le WAV.
function writePcmWav(samples, sampleRate, outPath) {
  const n = samples.length;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(outPath, Buffer.concat([header, data]));
  return outPath;
}
// Transcribe whatever remote audio was captured in `state` (a
// remoteState from newRemoteState). Prefers Web Audio PCM (primary);
// falls back to MediaRecorder WebM chunks. Clears the consumed audio.
// Returns '' when nothing was captured or transcription fails.
async function transcribeRemote(state) {
  if (state.pcmSamples > 0) {
    const samples = takePcm(state);
    state.chunks.length = 0; // same audio window — don't transcribe twice
    const wav = path.join(__dirname, 'remote-' + Date.now() + '.wav');
    try {
      writePcmWav(samples, state.pcmSampleRate, wav);
      return await transcribe(wav);
    } catch (e) {
      log('stt', 'PCM transcription failed: ' + e.message);
      return '';
    } finally {
      try { fs.unlinkSync(wav); } catch (_) {}
    }
  }
  if (!state.chunks.length) return '';
  const webm = Buffer.concat(state.chunks);
  state.chunks.length = 0;
  const tmp = path.join(__dirname, 'remote-' + Date.now() + '.webm');
  try {
    fs.writeFileSync(tmp, webm);
    return await transcribe(tmp);
  } catch (e) {
    log('stt', 'transcription failed: ' + e.message);
    return '';
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
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
    // prompt. In MIC_MODE=fake-file, Chromium's built-in file-as-mic is
    // used: --use-fake-device-for-media-stream + --use-file-for-fake-
    // audio-capture=<wav> (+ --disable-audio-input). Those three flags
    // are REQUIRED for the fake-file mic and are the ONLY method with
    // verified end-to-end WebRTC audio flow. In MIC_MODE=pipe they must
    // NOT be present — --use-fake-device-for-media-stream bypasses
    // PulseAudio entirely (so the pipe-source mic is never used) and
    // --use-file-for-fake-audio-capture forces silence as mic input.
    // So the fake-file flags are added ONLY in fake-file mode.
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--no-sandbox', '--disable-dev-shm-usage'].concat(extraArgs || []),
  };
  if (MIC_MODE === 'fake-file') {
    const flagVal = fakeFileFlagValue();
    opts.args.push('--use-fake-device-for-media-stream');
    opts.args.push('--use-file-for-fake-audio-capture=' + flagVal);
    opts.args.push('--disable-audio-input');
    log('fake-file', 'Chromium mic = file ' + flagVal);
  }
  // On GitHub Actions Playwright installs its own Chromium; on this VM
  // the path is fixed. Honour an explicit path when set.
  if (process.env.PLAYWRIGHT_CHROME_PATH) opts.executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
  return opts;
}

// Launch the configured browser for the host check. Firefox in
// fake-file mode uses the fake-stream prefs (generated tone mic);
// Firefox in pipe mode uses the REAL PulseAudio default source
// (virtmic) — no fake pref — with permission auto-granted so
// getUserMedia never blocks on a prompt. Chromium/Chrome use
// chromium.launch with chromiumOpts (fake-file flags when applicable).
async function launchHostBrowser(extraArgs) {
  if (IS_FIREFOX) {
    const prefs = { 'media.navigator.permission.disabled': true };
    if (MIC_MODE === 'fake-file') prefs['media.navigator.streams.fake'] = true;
    return firefox.launch({ headless: true, firefoxUserPrefs: prefs });
  }
  return chromium.launch(chromiumOpts(extraArgs));
}

// Launch a PERSISTENT browser context for the live call (TextNow login
// session lives in the profile dir). Firefox uses its own profile dir
// (a Chrome profile is not a Firefox profile) with permission
// auto-granted and NO fake-stream pref — the real PulseAudio virtmic
// is the mic in pipe mode. Firefox + fake-file is refused by liveCall
// (the generated tone cannot speak the order); use pipe.
async function launchCallPersistentContext() {
  if (IS_FIREFOX) {
    // HEADED under xvfb (the workflow runs xvfb-run): a headed browser is
    // far less likely to be Cloudflare-challenged than headless, and a
    // challenge page can auto-solve in a real browser. Run #20 (headless)
    // hit a Cloudflare challenge that hid the dial input entirely.
    return firefox.launchPersistentContext(FIREFOX_PROFILE_DIR, {
      headless: false,
      firefoxUserPrefs: { 'media.navigator.permission.disabled': true },
    });
  }
  return chromium.launchPersistentContext(PROFILE_DIR, chromiumOpts());
}

// ---------- WebRTC host check (dry-run phase 1) ----------
// Returns { udpOk, turnRelay, twoPeerConnected, twoPeerRms, micLabel, recvDb, recvBytes, micMode }.
// UDP: direct socket send to loopback + to a public STUN host.
// TURN: ICE gathering against openrelay.metered.ca (TCP/TLS).
// Two-peer: two RTCPeerConnections in-page; peer A uses the mic and
// peer B's received audio is measured TWO ways: Web Audio PCM (primary
// — raw Float32 via ScriptProcessor, RMS in Node) and MediaRecorder
// (fallback — decoded + ffmpeg volumedetect). PASS if either RMS > 0.005.
//  - MIC_MODE=pipe (default): peer A uses the REAL pipe-source mic
//    (virtmic); a tone is written into the pipe.
//  - MIC_MODE=fake-file: peer A uses Chromium's built-in file-as-mic
//    (the tone WAV loops automatically); no PulseAudio at all. Firefox
//    fake-file uses the generated-tone fake stream instead.
//    Run #20 (Firefox fake-file) PASSED — Firefox's WebRTC receive path
//    works on this host where Chromium's decoded silence. The real
//    two-way call needs Firefox + pipe (dynamic order audio as mic).
async function hostCheck() {
  const out = { udpOk: false, turnRelay: false, twoPeerConnected: false, twoPeerRms: 0, micLabel: '', recvDb: null, recvBytes: 0, micRecDb: null, micRecRms: 0, micMode: MIC_MODE, bytesSent: null, bytesReceived: null, packetsSent: null, packetsReceived: null, ontrackFired: null, remoteTrack: null, recorderState: null, webaudioRms: 0, webaudioSamples: 0, recvVia: 'none' };
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

  // Fake-file mode: generate the tone WAV BEFORE launching Chromium
  // (the flag needs the real file to exist at launch; it is loaded
  // whole at first capture). No pipe, no PulseAudio needed.
  // Firefox: no WAV — the fake-stream pref generates the tone.
  // Pipe mode: open the pipe BEFORE launching Chromium so the
  // pipe-source is live (fed with silence) when Chromium opens the mic.
  if (MIC_MODE === 'fake-file') {
    if (!IS_FIREFOX) {
      try { await makeFakeMicToneWav(880, 60, FAKE_MIC_WAV); } catch (e) { log('host', 'fake-mic WAV failed: ' + e.message); }
    } else {
      log('host', 'firefox fake-stream mic (generated tone via media.navigator.streams.fake)');
    }
  } else {
    try { await ensurePipe(); } catch (e) { log('host', 'pipe open failed: ' + e.message); }
  }

  const browser = await launchHostBrowser(['--disable-features=WebRtcHideLocalIpsWithMdns']);
  try { log('host', 'browser: ' + (await browser.version()) + ' (' + (IS_FIREFOX ? 'firefox' : (process.env.PLAYWRIGHT_CHROME_PATH ? 'chrome custom path ' + process.env.PLAYWRIGHT_CHROME_PATH : 'playwright chromium')) + ')'); } catch (_) {}
  let blank = null;
  try {
    const page = await browser.newPage();
    await page.addInitScript(INJECT);
    // about:blank is not a secure context (no navigator.mediaDevices),
    // so serve a blank page from localhost instead.
    blank = await serveBlankPage();
    await page.goto(blank.url);
    // Expose the remote-audio receivers BEFORE the two-peer setup so
    // the Web Audio PCM batches (primary) and MediaRecorder chunks
    // (fallback) are captured from the moment the remote track arrives.
    const hostPcm = newRemoteState();
    await exposeRemoteReceivers(page, hostPcm);
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
      // UDP path exists — try two peers over host/srflx. Fake-file mode:
      // the mic is Chromium's built-in file-as-mic (the tone WAV loops
      // automatically); no pipe, no virtmic. Pipe mode: the REAL
      // pipe-source mic (virtmic). The remote side is measured with
      // MediaRecorder (not a Web Audio Analyser).
      const setup = await page.evaluate(async (isFakeFile) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let micInfo = null;
        let micStream = null;
        // APM off: it can gate non-speech audio (the tone is non-speech).
        const apmOff = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        try {
          if (isFakeFile) {
            // Fake-file mic: the fake device is the only audio input —
            // no virtmic selection needed. Just open it with APM off.
            micStream = await navigator.mediaDevices.getUserMedia({ audio: apmOff });
            const track = micStream.getAudioTracks()[0];
            micInfo = { label: track.label || '', readyState: track.readyState, enabled: track.enabled, virtmicFound: false, fakeFile: true, devices: [] };
          } else {
            // Labels are only revealed after permission, so get a temp
            // stream first, enumerate, then open virtmic EXPLICITLY by
            // deviceId (the default device has an empty label by design
            // and may not be virtmic). APM off: it can gate non-speech audio.
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
          }
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
          window.__hostOntrack = true;
          window.__hostRemoteTrack = rtrack;
          try {
            const r = new MediaRecorder(new MediaStream([rtrack]));
            r.ondataavailable = (e2) => { if (e2.data && e2.data.size) rec.chunks.push(e2.data); };
            r.onstop = () => rec.resolve();
            r.start(250);
            rec.recorder = r;
          } catch (e) { rec.resolve(); }
        };
        window.__hostRec = rec;
        // Keep the peer connections reachable from later evaluates so
        // getStats can be read after the recording window.
        window.__hostPCs = { pcA, pcB };
        // Expose the mic stream so later evaluates can measure the LOCAL
        // track RMS (distinguishes "fake device delivers silence" from
        // "encoder/transport eats the tone").
        window.__hostMicStream = micStream;
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
      }, IS_FAKE_MIC);
      log('host', 'two-peer setup: connected=' + setup.ok + ' state=' + (setup.state || '?') +
        ' mic=' + (setup.micInfo ? JSON.stringify(setup.micInfo) : 'none') +
        (setup.micError ? ' micError=' + setup.micError : ''));
      out.micLabel = setup.micInfo ? setup.micInfo.label : '';
      out.twoPeerConnected = !!setup.ok;
      if (setup.ok) {
        if (IS_FAKE_MIC) {
          // Fake mic: Chromium fake-file = the 60s tone WAV (covers the
          // whole test even if it plays once and never loops); Firefox
          // fake-stream = the pref's generated tone. No pipe tone, no
          // PulseAudio diagnostics (there is no sound server).
          // DECISIVE diagnostic first: measure the LOCAL mic track RMS
          // in-page (Web Audio Analyser on window.__hostMicStream).
          // If local RMS ~0.7 the fake device works and the failure is
          // in the encoder/transport; if ~0 the fake device itself
          // delivers silence on this host. Then let the remote peer
          // record the tone for the remaining ~4s.
          // Headless Firefox can hang on ctx.resume() forever (no audio
          // device to start rendering against) — run #17 stalled here
          // for 26+ min with no log output. Race the resume against a
          // 3s timeout and read the Analyser regardless (a suspended
          // context yields zeros, which is itself diagnostic). The whole
          // measurement is also raced against a 15s Node-side timeout so
          // a hung evaluate can never stall the run again.
          try {
            const localMic = await Promise.race([
              page.evaluate(async () => {
                const stream = window.__hostMicStream;
                if (!stream) return { error: 'no mic stream on window' };
                const track = stream.getAudioTracks()[0];
                if (!track) return { error: 'no audio track' };
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                // Don't await resume() bare: race it so a context that
                // never starts (headless Firefox, no audio device)
                // can't hang this measurement.
                await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 3000))]);
                const src = ctx.createMediaStreamSource(stream);
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 2048;
                src.connect(analyser);
                const buf = new Float32Array(analyser.fftSize);
                let max = 0;
                for (let i = 0; i < 4; i++) {
                  await new Promise((r) => setTimeout(r, 500));
                  analyser.getFloatTimeDomainData(buf);
                  let sum = 0;
                  for (let j = 0; j < buf.length; j++) sum += buf[j] * buf[j];
                  max = Math.max(max, Math.sqrt(sum / buf.length));
                }
                return { rms: +max.toFixed(4), muted: track.muted, enabled: track.enabled, readyState: track.readyState, label: track.label || '', ctxState: ctx.state };
              }),
              new Promise((resolve) => setTimeout(() => resolve({ error: 'local mic measure timed out after 15s' }), 15000)),
            ]);
            if (localMic.error) {
              log('host', 'local mic track: ' + localMic.error);
            } else {
              out.localMicRms = localMic.rms;
              log('host', 'local mic track rms=' + localMic.rms.toFixed(4) + ' muted=' + localMic.muted + ' enabled=' + localMic.enabled + ' state=' + localMic.readyState + ' label=' + localMic.label + ' ctxState=' + (localMic.ctxState || '?'));
            }
          } catch (e) { log('host', 'local mic track measure failed: ' + e.message); }
          log('host', (IS_FIREFOX ? 'firefox fake-stream mic (generated tone)' : 'fake-file mic (60s tone)') + '; letting the remote peer record ~4s');
          await sleep(4000);
        } else {
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
        }
        // DEFINITIVE audio-flow diagnostic: getStats on BOTH peer
        // connections, read BEFORE stopping the recorder. MediaRecorder
        // can be blind (0 chunks) even when RTP flows. If A bytesSent > 0
        // the sender IS sending audio (mic works; the measurement is
        // blind). If bytesSent = 0 the sender genuinely sends nothing
        // (the mic/track produces no audio into the peer). Also captures
        // the remote track + MediaRecorder state so a 0-chunk capture is
        // diagnosable. PASS criterion unchanged (RMS > 0.005).
        try {
          const stats = await page.evaluate(async () => {
            const pcs = window.__hostPCs;
            if (!pcs) return { error: 'no peer connections on window' };
            const summarize = async (pc) => {
              const rep = await pc.getStats();
              let outbound = null, inbound = null;
              rep.forEach((s) => {
                if (s.type === 'outbound-rtp' && s.kind === 'audio') outbound = { bytesSent: s.bytesSent || 0, packetsSent: s.packetsSent || 0, audioLevel: (typeof s.audioLevel === 'number' ? s.audioLevel : null) };
                if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = { bytesReceived: s.bytesReceived || 0, packetsReceived: s.packetsReceived || 0, audioLevel: (typeof s.audioLevel === 'number' ? s.audioLevel : null) };
              });
              return { outbound, inbound, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState };
            };
            const a = await summarize(pcs.pcA);
            const b = await summarize(pcs.pcB);
            const rec = window.__hostRec;
            const rtrack = window.__hostRemoteTrack;
            return {
              pcA: a, pcB: b,
              ontrackFired: !!window.__hostOntrack,
              remoteTrack: rtrack ? { readyState: rtrack.readyState, muted: rtrack.muted, enabled: rtrack.enabled } : null,
              recorder: rec && rec.recorder ? { state: rec.recorder.state, chunks: rec.chunks.length } : null,
            };
          });
          if (stats.error) {
            log('host', 'stats: ' + stats.error);
          } else {
            const aOut = stats.pcA.outbound, bIn = stats.pcB.inbound;
            out.bytesSent = aOut ? aOut.bytesSent : null;
            out.packetsSent = aOut ? aOut.packetsSent : null;
            out.bytesReceived = bIn ? bIn.bytesReceived : null;
            out.packetsReceived = bIn ? bIn.packetsReceived : null;
            out.ontrackFired = stats.ontrackFired;
            out.remoteTrack = stats.remoteTrack;
            out.recorderState = stats.recorder ? stats.recorder.state : null;
            log('host', 'stats: A bytesSent=' + (out.bytesSent === null ? 'n/a' : out.bytesSent) + ' packetsSent=' + (out.packetsSent === null ? 'n/a' : out.packetsSent) +
              ' audioLevel=' + (aOut && aOut.audioLevel !== null && aOut.audioLevel !== undefined ? aOut.audioLevel : 'n/a') +
              ' | B bytesReceived=' + (out.bytesReceived === null ? 'n/a' : out.bytesReceived) + ' packetsReceived=' + (out.packetsReceived === null ? 'n/a' : out.packetsReceived) +
              ' audioLevel=' + (bIn && bIn.audioLevel !== null && bIn.audioLevel !== undefined ? bIn.audioLevel : 'n/a') +
              ' | ontrack=' + stats.ontrackFired +
              ' remoteTrack=' + (stats.remoteTrack ? stats.remoteTrack.readyState + '/muted=' + stats.remoteTrack.muted + '/enabled=' + stats.remoteTrack.enabled : 'none') +
              ' recorder=' + (stats.recorder ? stats.recorder.state + ' chunks=' + stats.recorder.chunks : 'none'));
          }
        } catch (e) { log('host', 'stats failed: ' + e.message); }
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
            // Browser-native base64 (no Node Buffer inside the page).
            const bytes = new Uint8Array(ab);
            let bin = '';
            const CH = 8192;
            for (let i = 0; i < bytes.length; i += CH) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            }
            bufs.push(btoa(bin));
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
        // Web Audio PCM (PRIMARY receive path): flush any buffered
        // page PCM to Node, then measure its RMS. MediaRecorder can be
        // blind (0 chunks) even when RTP flows; the PCM path pulls audio
        // through the Web Audio graph, so it measures the real level.
        try {
          await page.evaluate(() => { try { window.__hailmary.flushPcm(true); } catch (_) {} }).catch(() => {});
          await sleep(300);
        } catch (e) { /* page PCM flush unavailable */ }
        out.webaudioRms = +pcmStateRms(hostPcm).toFixed(4);
        out.webaudioSamples = hostPcm.pcmSamples;
        // Fallback: if Node received no PCM (expose not wired), read the
        // in-page RMS directly (the page buffers PCM when Node is not
        // listening).
        if (hostPcm.pcmSamples === 0) {
          try {
            const pageRms = await page.evaluate(() => {
              try { return window.__hailmary.pcmRms(); } catch (_) { return 0; }
            });
            if (pageRms > 0) {
              out.webaudioRms = +pageRms.toFixed(4);
              out.webaudioSamples = await page.evaluate(() => {
                try { return window.__hailmary.pcmCount(); } catch (_) { return 0; }
              });
            }
          } catch (e) { /* in-page RMS unavailable */ }
        }
        out.recvVia = out.webaudioRms > 0.005 ? (out.twoPeerRms > 0.005 ? 'both' : 'webaudio') : (out.twoPeerRms > 0.005 ? 'mediarecorder' : 'none');
        log('host', 'remote level via webaudio rms=' + out.webaudioRms.toFixed(4) + ' samples=' + out.webaudioSamples +
          ' | via mediarecorder rms=' + out.twoPeerRms.toFixed(4) + ' bytes=' + out.recvBytes +
          ' | recvVia=' + out.recvVia);
        log('host', 'two-peer: state=' + setup.state + ' mic=' + (out.micLabel || '?') +
          ' recvBytes=' + out.recvBytes + ' meanDb=' +
          (out.recvDb === null || out.recvDb === undefined ? 'n/a' : (out.recvDb === -Infinity ? '-inf' : out.recvDb)) +
          ' recvRMS=' + out.twoPeerRms.toFixed(4) +
          ' webaudioRMS=' + out.webaudioRms.toFixed(4) + ' recvVia=' + out.recvVia +
          ' micRecDb=' + (out.micRecDb === null || out.micRecDb === undefined ? 'n/a' : (out.micRecDb === -Infinity ? '-inf' : out.micRecDb)) +
          ' micRecRMS=' + out.micRecRms.toFixed(4) +
          ' bytesSent=' + (out.bytesSent === null || out.bytesSent === undefined ? 'n/a' : out.bytesSent) +
          ' bytesReceived=' + (out.bytesReceived === null || out.bytesReceived === undefined ? 'n/a' : out.bytesReceived));
      }
    }
  } finally {
    if (blank) blank.close();
    await browser.close();
  }
  return out;
}

// ---------- Audio helpers ----------
// Play an MP3 buffer through the mic. Returns duration in seconds.
// Pipe mode: decodes to PCM and writes it into the pipe-source mic
// (the mic hears it). The page argument is unused — playback is
// Node-side pipe writes, not Web Audio — but the signature is kept so
// callers don't change.
// Fake-file mode: NO-OP for playback — the mic is a FIXED WAV loaded
// at Chromium launch, so new audio cannot be written into it. The
// duration is still returned (decoded) so callers log sensibly, but
// nothing is heard. This is the one-shot limit of the fake-file mic:
// the ORDER audio (already the mic WAV) is what the far end hears;
// replies picked by the responder cannot be spoken in this mode.
async function playAudio(page, audioBuf) {
  const { pcm, seconds } = await mp3ToPcm(audioBuf);
  if (MIC_MODE === 'fake-file') {
    log('speak', 'fake-file mode: audio NOT played into mic (fixed WAV; order already delivered via mic)');
    return seconds;
  }
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
    // Prefers Web Audio PCM (primary); falls back to MediaRecorder WebM.
    return transcribeRemote(remoteState);
  }

  async function speakReply(key) {
    // Fake-file mode: the mic is a FIXED WAV — a reply picked now
    // cannot be spoken (the order WAV already played / is looping).
    // Log it and skip; the pipe path is the only live/dynamic mic.
    if (MIC_MODE === 'fake-file') {
      log('speak', 'fake-file mode: reply "' + key + '" NOT spoken (fixed WAV mic — cannot play new audio)');
      return 0;
    }
    const file = path.join(AUDIO_DIR, key + '.mp3');
    const buf = fs.readFileSync(file);
    const dur = await playAudio(page, buf);
    log('speak', 'reply "' + key + '" played (' + dur.toFixed(1) + 's)');
    await sleep(Math.min(dur * 1000 + 400, 6000));
    return dur;
  }

  const t0 = Date.now();
  log('listen', 'two-way loop started (timeout ' + (CONVERSATION_TIMEOUT_MS / 1000) + 's)');
  // Speech detection (three signals, any one counts):
  //  - Web Audio PCM (PRIMARY): a recent ~500ms batch above threshold.
  //    The ScriptProcessor forces the graph to render, so this works
  //    even when MediaRecorder/Analyser read 0 in headless Chrome.
  //  - remote Analyser level (can read 0 in headless even when audio
  //    flows — kept as a secondary signal).
  //  - MediaRecorder chunk growth (chunks for speech are much larger
  //    than silence frames).
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
    // Web Audio PCM: batches arrive ~every 500ms, so accept one up to
    // 800ms old. lastPcmRms is the RMS of the most recent batch.
    const pcmSpeech = (Date.now() - remoteState.lastPcmAt) < 800 && remoteState.lastPcmRms > REMOTE_LEVEL_THRESHOLD;
    const now = Date.now();
    if (level > REMOTE_LEVEL_THRESHOLD || chunkSpeech || pcmSpeech) {
      if (!speaking) { speaking = true; log('listen', 'staff speaking (level ' + level.toFixed(3) + (chunkSpeech ? ', chunk' : '') + (pcmSpeech ? ', pcm ' + remoteState.lastPcmRms.toFixed(3) : '') + ')'); }
      lastSpeechAt = now;
    } else if (speaking && now - lastSpeechAt > UTTERANCE_SILENCE_MS && now - remoteState.lastChunkAt > 500 && now - remoteState.lastPcmSpeechAt > 500) {
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
        // Fake-file mode: the order WAV already played (once with
        // %noloop) — it cannot be replayed into a fixed WAV mic.
        if (MIC_MODE === 'fake-file') {
          log('respond', 'staff asked to repeat — fake-file mode: cannot replay (fixed WAV mic)');
          continue;
        }
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
// MIC_MODE=fake-file: phase 2 is instead a ONE-SHOT order verification
// (the order WAV is the mic; the peer must capture it). No two-way
// loop — live replies are impossible with a fixed WAV mic.

// Fake-file mode, phase 2: one-shot ORDER verification. The order WAV
// is the mic (looping, so audio is always present). Two peers connect;
// the remote peer (pcB) must capture the order audio. This proves the
// order would be heard on a real call. There is NO two-way loop here —
// live replies are impossible with a fixed WAV mic, so the responder
// is not exercised in this mode (it is a pure function, already
// covered by the pipe-mode dry run). Returns the dry-run result.
async function dryRunFakeFile(order, script, orderAudio, host) {
  const result = { ok: false, mode: 'dry-run', micMode: 'fake-file', host, transcript: [], turns: 0 };
  log('dry-run', 'phase 2 (fake-file) — one-shot order playback to a peer');
  // The ORDER audio is the mic WAV (looping, not %noloop, so audio is
  // present for the whole verification).
  await mp3ToWavFile(orderAudio, FAKE_MIC_WAV);
  const browser = await chromium.launch(chromiumOpts());
  let blank = null;
  try {
    const page = await browser.newPage();
    await page.addInitScript(INJECT);
    blank = await serveBlankPage();
    await page.goto(blank.url);
    // Receive remote audio (Web Audio PCM primary, MediaRecorder
    // fallback) from the peer that hears the order WAV.
    const simState = newRemoteState();
    await exposeRemoteReceivers(page, simState);
    const chunks = simState.chunks; // MediaRecorder fallback (same array)
    const sim = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const apmOff = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      let micLabel = '';
      let micStream = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: apmOff });
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
    // Let the looping order WAV flow to the peer, then check capture.
    await sleep(8000);
    const bytes = chunks.reduce((n, b) => n + b.length, 0);
    const orderPcmRms = pcmStateRms(simState);
    log('dry-run', 'order WAV captured by peer: pcmSamples=' + simState.pcmSamples + ' pcmRms=' + orderPcmRms.toFixed(4) + ' | chunks=' + chunks.length + ' bytes=' + bytes);
    const orderCaptured = (simState.pcmSamples > 0 && orderPcmRms > 0.005) || (chunks.length > 0 && bytes > 1000);
    if (!orderCaptured) {
      result.error = 'order audio was not captured by the peer (pcmSamples=' + simState.pcmSamples + ', pcmRms=' + orderPcmRms.toFixed(4) + ', chunks=' + chunks.length + ', bytes=' + bytes + ')';
      return result;
    }
    // Transcribe the captured order audio to confirm it is the order
    // (prefers Web Audio PCM; falls back to MediaRecorder WebM).
    const text = await transcribeRemote(simState);
    log('dry-run', 'Whisper transcribed captured order audio as: "' + text + '"');
    result.transcript.push({ speaker: 'us', text: '(order via fake-file mic) ' + script.text });
    if (text) result.transcript.push({ speaker: 'peer-heard', text });
    result.ok = true;
    result.note = 'fake-file one-shot: order audio flows to the peer. Live replies are NOT possible in this mode (fixed WAV mic); use MIC_MODE=pipe for a two-way conversation.';
    return result;
  } finally {
    if (blank) blank.close();
    await browser.close();
  }
}

async function dryRun(order, script, orderAudio) {
  log('dry-run', 'phase 1 — WebRTC host check');
  const host = await hostCheck();
  // PASS if EITHER receive path proves audio: Web Audio PCM RMS or
  // MediaRecorder RMS above 0.005 (either proves the remote track
  // carries audio).
  const hostOk = host.udpOk && host.twoPeerConnected && (host.twoPeerRms > 0.005 || (host.webaudioRms || 0) > 0.005);
  log('dry-run', 'host check: udp=' + host.udpOk + ' turnRelay=' + host.turnRelay +
    ' twoPeer=' + host.twoPeerConnected + ' rms=' + host.twoPeerRms + ' webaudioRms=' + (host.webaudioRms || 0) + ' recvVia=' + (host.recvVia || '?') + ' -> ' + (hostOk ? 'PASS' : 'FAIL'));
  if (!hostOk) {
    return { ok: false, mode: 'dry-run', host, error: 'host WebRTC check failed (udp=' + host.udpOk + ', twoPeer=' + host.twoPeerConnected + ')' };
  }

  // Fake-file mode: phase 2 is a one-shot order verification (the
  // order WAV is the mic). No two-way loop — live replies are
  // impossible with a fixed WAV mic.
  if (MIC_MODE === 'fake-file') {
    return dryRunFakeFile(order, script, orderAudio, host);
  }

  log('dry-run', 'phase 2 — simulated staff conversation (two-peer loop)');
  await ensurePipe(); // pipe already open from hostCheck; no-op if so
  const browser = await launchHostBrowser(); // browser-aware: Firefox when BROWSER=firefox
  const result = { ok: false, mode: 'dry-run', host, transcript: [], turns: 0 };
  let blank = null;
  try {
    const page = await browser.newPage();
    await page.addInitScript(INJECT);
    // about:blank is not a secure context (no navigator.mediaDevices),
    // so serve a blank page from localhost instead.
    blank = await serveBlankPage();
    await page.goto(blank.url);
    // Expose the remote-audio receivers (Web Audio PCM primary,
    // MediaRecorder fallback — same as the live loop).
    const simState = newRemoteState();
    await exposeRemoteReceivers(page, simState);
    const chunks = simState.chunks; // MediaRecorder fallback (same array)
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
    const staffPcmRms = pcmStateRms(simState);
    log('dry-run', 'staff fixture played (' + staffDur.toFixed(1) + 's); peer B captured pcmSamples=' + simState.pcmSamples + ' pcmRms=' + staffPcmRms.toFixed(4) + ' | chunks=' + chunks.length + ' bytes=' + staffBytes);
    const staffCaptured = (simState.pcmSamples > 0 && staffPcmRms > 0.005) || (chunks.length > 0 && staffBytes > 1000);
    if (!staffCaptured) {
      result.error = 'simulated staff audio was not captured (pcmSamples=' + simState.pcmSamples + ', pcmRms=' + staffPcmRms.toFixed(4) + ', chunks=' + chunks.length + ', bytes=' + staffBytes + ')';
      return result;
    }
    // Transcribe the captured audio with Whisper (prefers Web Audio
    // PCM; falls back to MediaRecorder WebM). Clears both buffers, so
    // the reply capture below starts fresh.
    const text = await transcribeRemote(simState);
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
    const replyPcmRms = pcmStateRms(simState);
    log('dry-run', 'reply "' + res.key + '" played (' + playedSec.toFixed(1) + 's); peer B captured pcmSamples=' + simState.pcmSamples + ' pcmRms=' + replyPcmRms.toFixed(4) + ' | chunks=' + chunks.length + ' bytes=' + replyBytes);
    result.ok = (simState.pcmSamples > 0 && replyPcmRms > 0.005) || (chunks.length > 0 && replyBytes > 1000);
    if (!result.ok) result.error = 'reply was not captured by the peer (pcmSamples=' + simState.pcmSamples + ', pcmRms=' + replyPcmRms.toFixed(4) + ', chunks=' + chunks.length + ', bytes=' + replyBytes + ')';
    return result;
  } finally {
    if (blank) blank.close();
    await browser.close();
  }
}

// ---------- Live call ----------
async function liveCall(order, script, orderAudio, to, orderId, idToken, directCode, onWaitingForCode) {
  const email = process.env.TEXTNOW_EMAIL || DEFAULT_EMAIL;
  // Fake-file mode (Chromium only): the ORDER audio IS the mic.
  // Convert the order MP3 to a real WAV (mono 48kHz s16) BEFORE
  // launching the browser — the flag needs the file to exist at
  // launch, and it is loaded whole at first capture. %noloop so the
  // order plays ONCE, then silence (looping would repeat the order to
  // the staff). ONE-SHOT: live replies to staff questions are NOT
  // possible in this mode — the pipe path is the only live/dynamic
  // mic. See converse(). Firefox + fake-file is refused: the
  // generated tone cannot speak the order — use pipe.
  // Pipe mode: open the pipe BEFORE launching the browser so the
  // pipe-source is live (fed with silence) when TextNow opens the mic.
  if (MIC_MODE === 'fake-file') {
    if (IS_FIREFOX) throw new Error('Firefox live calls require MIC_MODE=pipe — the fake-stream tone cannot speak the order');
    await mp3ToWavFile(orderAudio, FAKE_MIC_WAV);
    process.env.FAKE_MIC_NOLOOP = '1';
    log('fake-file', 'live call: order is the mic WAV (one-shot, %noloop); replies cannot be spoken in this mode');
  } else {
    await ensurePipe();
  }
  const context = await launchCallPersistentContext();
  await context.addInitScript(INJECT);
  const page = context.pages()[0] || await context.newPage();
  // Receive remote audio forwarded by inject.js. Exposed BEFORE
  // login/dial so no early staff audio is dropped (capture starts as
  // soon as a remote track is captured on call connect). Web Audio PCM
  // is the primary receive path; MediaRecorder chunks are the fallback.
  const remoteState = newRemoteState();
  await exposeRemoteReceivers(page, remoteState);
  try {
    await ensureLoggedIn(page, email, orderId, idToken, directCode, onWaitingForCode);
    event({ event: 'dialing', to });
    log('dial', 'opening the dialer');
    // After login the browser is ALREADY on /messaging: isLoggedIn navigated
    // there to check the session. Do NOT navigate again to the same URL —
    // a redundant same-URL goto hangs in this headless Firefox + TextNow
    // SPA (it timed out in both run #18 and run #19). Only navigate when
    // we are not already on the messaging page.
    if (!/\/messaging/i.test(page.url())) {
      let navigated = false;
      for (let attempt = 1; attempt <= 2 && !navigated; attempt++) {
        try {
          await page.goto(SELECTORS.appUrl, { waitUntil: 'commit', timeout: 30000 });
          navigated = true;
        } catch (e) {
          log('dial', 'goto attempt ' + attempt + ' failed: ' + e.message);
          if (attempt === 2) throw e;
          await page.waitForTimeout(2000);
        }
      }
    } else {
      log('dial', 'already on the messaging page — skipping the redundant goto');
    }
    await page.waitForTimeout(2000);
    // TextNow may route through a Cloudflare challenge (URL carries
    // __cf_chl_rt_tk) — the dial input does not exist until it clears.
    // Wait up to 60s for the challenge to resolve (headed Firefox under
    // xvfb auto-solves it), then proceed. Run #20 died here: the fill
    // timed out at 15s on a challenge page with no dial input.
    for (let i = 0; i < 30; i++) {
      if (!/__cf_chl/i.test(page.url())) break;
      log('dial', 'Cloudflare challenge in progress — waiting for it to clear…');
      await page.waitForTimeout(2000);
    }
    if (/__cf_chl/i.test(page.url())) {
      log('dial', 'Cloudflare challenge did not clear in 60s; trying the dial input anyway');
    }
    await page.locator(SELECTORS.newCallButton).first().click({ timeout: 30000 })
      .catch(() => log('dial', 'no separate new-call button; trying the dial input directly'));
    await page.fill(SELECTORS.dialInput, to, { timeout: 60000 });
    await page.click(SELECTORS.callButton, { timeout: 30000 });
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
    // Stop the pipe keepalive so it cannot keep the process alive, and do
    // not let a hung browser block exit: race the close against a timeout
    // so a navigation failure fails fast instead of hanging the step.
    pipeState.keepaliveOn = false;
    await Promise.race([
      context.close().catch(() => {}),
      sleep(10000),
    ]).catch(() => {});
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
    // Dial target: a Firebase order may carry its own `to` (e.g. a test
    // call to a buddy's number); otherwise fall back to --to / DEFAULT_TO
    // (the front desk). Log it so the dialed number is always visible.
    const dialTo = (order.to && String(order.to).trim()) || args.to;
    log('dial', 'dial target: ' + dialTo + (order.to ? ' (from order.to)' : ' (default --to)'));
    result = await liveCall(order, script, orderAudio, dialTo, args.orderId, idToken, args.code, onWaitingForCode);
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
