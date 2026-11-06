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
// Vexa pattern: the mic is Chromium's real default mic (PulseAudio
// virtual_mic, a remap source of tts_sink.monitor). TTS audio is played
// into tts_sink with paplay. Override with PULSE_TTS_SINK if needed.
const TTS_SINK = process.env.PULSE_TTS_SINK || 'tts_sink';
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

// ---------- PulseAudio helpers (Vexa pattern) ----------
// Audio is played into the tts_sink with paplay; the PulseAudio
// virtual_mic (remap source of tts_sink.monitor) feeds it to Chromium
// as the real mic. No Web Audio fake mic is used anywhere.
const { spawn, execFile } = require('child_process');
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

// Decode an MP3 buffer to a 44.1kHz WAV file. Returns the WAV path.
async function mp3ToWav(mp3Buf) {
  const tag = 'hailmary-play-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const tmpMp3 = path.join(os.tmpdir(), tag + '.mp3');
  const tmpWav = path.join(os.tmpdir(), tag + '.wav');
  fs.writeFileSync(tmpMp3, mp3Buf);
  try {
    await runCmd('ffmpeg', ['-y', '-v', 'error', '-i', tmpMp3, '-ac', '1', '-ar', '44100', '-f', 'wav', tmpWav], 60000);
    if (!fs.existsSync(tmpWav) || fs.statSync(tmpWav).size < 100) throw new Error('ffmpeg produced no usable WAV');
    return { wav: tmpWav, mp3: tmpMp3 };
  } catch (e) {
    try { fs.unlinkSync(tmpMp3); } catch (_) {}
    try { fs.unlinkSync(tmpWav); } catch (_) {}
    throw e;
  }
}

// Duration of an audio file in seconds (ffprobe).
async function audioDuration(file) {
  const { stdout } = await runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 30000);
  const d = parseFloat(String(stdout).trim());
  return Number.isFinite(d) ? d : 0;
}

// Play an MP3 buffer into the PulseAudio tts_sink (the mic hears it).
// Awaits playback completion. Returns the duration in seconds.
async function playToSink(mp3Buf, sink) {
  const { wav, mp3 } = await mp3ToWav(mp3Buf);
  try {
    const dur = await audioDuration(wav);
    await runCmd('paplay', ['--device=' + sink, wav], Math.max(60000, Math.ceil(dur * 1000) + 30000));
    return dur;
  } finally {
    try { fs.unlinkSync(wav); } catch (_) {}
    try { fs.unlinkSync(mp3); } catch (_) {}
  }
}

// Generate a sine tone WAV and start playing it into the sink.
// Returns the paplay ChildProcess (caller awaits/kills it). The WAV
// file is removed once playback ends.
function playToneToSink(freq, seconds, sink) {
  const tag = 'hailmary-tone-' + Date.now() + '.wav';
  const tmpWav = path.join(os.tmpdir(), tag);
  const child = spawn('sh', ['-c', 'ffmpeg -y -v error -f lavfi -i "sine=frequency=' + freq + ':duration=' + seconds + '" -ac 1 -ar 44100 -f wav "' + tmpWav + '" && paplay --device=' + sink + ' "' + tmpWav + '"; rm -f "' + tmpWav + '"'], { stdio: 'ignore' });
  return child;
}

// Mean volume (dB) of an audio file via ffmpeg volumedetect.
// Returns { meanDb, linear } — linear = 10^(dB/20); 0 when silent/empty.
async function measureVolumeDb(file) {
  try {
    const { stderr } = await runCmd('ffmpeg', ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], 60000);
    const m = /mean_volume:\s*(-?[\d.]+|-\s*inf)\s*dB/.exec(stderr);
    if (!m) return { meanDb: null, linear: 0 };
    if (/inf/i.test(m[1])) return { meanDb: -Infinity, linear: 0 };
    const db = parseFloat(m[1]);
    return { meanDb: db, linear: Number.isFinite(db) ? Math.pow(10, db / 20) : 0 };
  } catch (e) {
    return { meanDb: null, linear: 0 };
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
    // prompt. NEVER add --use-fake-device-for-media-stream (it bypasses
    // PulseAudio entirely, so the virtual mic is never used) or
    // --use-file-for-fake-audio-capture (forces silence as mic input).
    // Those two flags break the Vexa PulseAudio mic (see inject.js).
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
// PulseAudio mic (virtual_mic), a tone is played into tts_sink with
// paplay, and peer B's received audio is measured with MediaRecorder
// (decoded + ffmpeg volumedetect). This tests the Vexa mic path —
// the old Web Audio tone test is gone (it was always silent here).
async function hostCheck() {
  const out = { udpOk: false, turnRelay: false, twoPeerConnected: false, twoPeerRms: 0, micLabel: '', recvDb: null, recvBytes: 0 };
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
      // UDP path exists — try two peers over host/srflx, using the REAL
      // PulseAudio mic (virtual_mic). A tone is played into tts_sink
      // with paplay and must arrive at the remote peer; the remote side
      // is measured with MediaRecorder (not a Web Audio Analyser).
      const setup = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let micInfo = null;
        let micStream = null;
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const track = micStream.getAudioTracks()[0];
          micInfo = { label: track.label || '', readyState: track.readyState, enabled: track.enabled };
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
        // Play a 6s tone into tts_sink while the remote peer records.
        const toneProc = playToneToSink(880, 6, TTS_SINK);
        await new Promise((res) => { toneProc.on('close', res); toneProc.on('error', res); });
        await sleep(800); // let the last recorder slice flush
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
          ' recvRMS=' + out.twoPeerRms.toFixed(4));
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

// ---------- Audio helpers ----------
// Play an MP3 buffer into the PulseAudio tts_sink (the mic hears it).
// Returns duration in seconds. The page argument is unused — playback
// is Node-side paplay, not Web Audio — but the signature is kept so
// callers don't change.
async function playAudio(page, audioBuf) {
  return playToSink(audioBuf, TTS_SINK);
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
// utterance through the real PulseAudio mic, peer B captures it,
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
    const sim = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let micLabel = '';
      let micStream = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    // Play the staff utterance into the real mic (paplay -> tts_sink).
    const staffDur = await playToSink(staffAudio, TTS_SINK);
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
    // play it via paplay and check peer B captures new audio.
    const replyBuf = fs.readFileSync(path.join(AUDIO_DIR, res.key + '.mp3'));
    const playedSec = await playAudio(page, replyBuf);
    await sleep(1500);
    const replyBytes = chunks.reduce((n, b) => n + b.length, 0);
    log('dry-run', 'reply "' + res.key + '" played (' + playedSec.toFixed(1) + 's); peer B captured chunks=' + chunks.length + ' bytes=' + replyBytes);
    result.ok = chunks.length > 0 && replyBytes > 1000;
    if (!result.ok) result.error = 'reply was not captured by the peer (chunks=' + chunks.length + ', bytes=' + replyBytes + ')';
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
