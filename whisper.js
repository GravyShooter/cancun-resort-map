// whisper.js — transcribe an audio file with whisper.cpp (free, offline).
// No API key, no account. The GitHub Actions workflow installs
// whisper.cpp and downloads the tiny model; this wrapper calls the
// binary on a 16kHz mono WAV and returns the plain transcript.
//
//   const { transcribe } = require('./whisper');
//   const text = await transcribe(wavPath, { binary, model });
//
// `binary` is the whisper.cpp CLI path (whisper-cli or main).
// `model` is the ggml model path (e.g. ggml-tiny.en.bin).
// Returns the transcript as a string ('' when nothing was recognised).
// Throws on a missing file / binary failure so the caller can fall
// back (stay silent and keep listening) rather than hang up.

const { execFile } = require('child_process');
const fs = require('fs');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs || 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(cmd + ' failed: ' + (stderr || err.message).slice(0, 300)));
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

// Convert a WebM/Opus (or MP3/WAV) file to 16kHz mono WAV with ffmpeg.
// Returns the WAV path. Throws on failure.
async function toWav16k(inputPath, wavPath) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', inputPath, '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath], 60000);
  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 100) {
    throw new Error('ffmpeg produced no usable WAV for ' + inputPath);
  }
  return wavPath;
}

// Run whisper.cpp on a 16kHz mono WAV. Returns plain transcript text.
async function transcribeWav(wavPath, opts) {
  const binary = (opts && opts.binary) || process.env.WHISPER_BIN || 'whisper-cli';
  const model = (opts && opts.model) || process.env.WHISPER_MODEL || 'ggml-tiny.en.bin';
  // -np: no prints; -nt: no timestamps; -otxt is not used — parse stdout.
  const args = [binary, '-m', model, '-f', wavPath, '-np', '-nt', '-l', 'en'];
  const { stdout } = await run(args[0], args.slice(1), 120000);
  // whisper-cli prints one line per segment (plain text when -nt is set).
  // Strip any bracketed tags and collapse whitespace.
  const text = stdout
    .split('\n')
    .map((l) => l.replace(/^\[.*?\]\s*/, '').trim())
    .filter((l) => l && !/^(whisper|main|ggml|system_info|load|print)/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

// Full pipeline: audio file (webm/mp3/wav) -> WAV 16k -> whisper -> text.
async function transcribe(inputPath, opts) {
  const tmpWav = inputPath + '.16k.wav';
  try {
    await toWav16k(inputPath, tmpWav);
    return await transcribeWav(tmpWav, opts);
  } finally {
    try { fs.unlinkSync(tmpWav); } catch (_) {}
  }
}

module.exports = { transcribe, transcribeWav, toWav16k };
