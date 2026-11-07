# Hail Mary GHA — FREE two-way conversational room-service caller

A two-way (listen + respond) room-service caller that runs on **GitHub
Actions** — a free host where WebRTC/UDP works. This VM blocks WebRTC
(UDP EPERM, TURN fails), so the caller **cannot** run here; the GitHub
Actions runner is a standard Ubuntu VM with direct internet, no egress
proxy, and UDP allowed by default.

Free. No paid accounts, no top-ups, no per-minute charges beyond
FreeCallMe's free first call (up to $0.25 — the buddy test + the
front-desk call both fit). No API keys. whisper.cpp is free and
offline. The voice is Chatty Porch (Chris's voice) via pre-generated
MP3s. The rule-based responder needs no LLM.

FreeCallMe replaces TextNow (Cloudflare-blocked on the GitHub runner).
Dialer selectors are verified from the server-rendered dialer HTML;
the sign-in modal and in-call screen selectors are generic patterns
and the first live run dumps the page state on failure.

## How it works

```
order page / parent --write--> Firebase hailmary-orders-2way/<id>
                                  (status "queued", orderAudioB64 = Chatty
                                   Porch MP3 of the order script)
GitHub Actions (every 5 min, or manual Run workflow)
  -> poll Firebase for a queued two-way order
  -> run gha-call.js --live
       - sign in to FreeCallMe (email OTP; 6-digit code or magic link
         from Gmail, relayed via Firebase)
       - dial +52 998 872 8500, play the order (Chatty Porch)
       - LISTEN: capture the staff's voice (inject.js remote-track hook)
       - transcribe with whisper.cpp (offline, tiny.en model)
       - respond with a rule-based reply (pre-generated Chatty Porch MP3)
       - loop until the staff says goodbye or ~90s pass
       - hang up, write the transcript + outcome back to Firebase
order page polls Firebase and shows done/failed + the transcript
```

## Files

| File | What it is |
|---|---|
| `gha-call.js` | Two-way call script (live + dry-run). Ports call.js's live flow and adds the listen→transcribe→respond loop. |
| `respond.js` | Rule-based responder (no LLM). Maps staff speech to a reply key. |
| `whisper.js` | whisper.cpp wrapper (ffmpeg WebM→WAV 16k, then whisper-cli). |
| `firebase.js` | Firebase REST helper (anonymous sign-in, read/patch order, wait for the login code). Two-way node is `hailmary-orders-2way` (separate from the one-way `hailmary-orders`, so the VM watcher never claims two-way orders). |
| `poll-queued.js` | Finds the oldest queued two-way order (used by the scheduled run). |
| `test-host.js` | Standalone WebRTC host check (UDP, TURN ICE, two-peer). |
| `script.js`, `inject.js`, `menu.json` | Copied from the one-way backend (natural script, audio injection + remote-track capture, ES menu names). |
| `audio/` | Pre-generated Chatty Porch MP3s: 8 rule-based replies (ack, everything, room, name, time_ack, skip, goodbye, fallback) + 3 staff test utterances for the dry-run. |
| `.github/workflows/webrtc-test.yml` | Host verification workflow (run first). |
| `.github/workflows/room-service-call.yml` | Main two-way call workflow (manual + every-5-min schedule). |
| `sample-order.json` | Example order (dry-run / local testing). |

## The two-way loop (how it listens and answers)

1. The order script plays into the fake mic (Chatty Porch).
2. `inject.js` hooks `RTCPeerConnection` and records every incoming
   remote audio track with MediaRecorder (250 ms WebM/Opus chunks),
   forwarding each chunk to Node via `window.__sendAudioChunk`.
3. `gha-call.js` collects chunks and meters `remoteLevel()`. When the
   staff speaks and then goes silent for ~1.5 s, the utterance is over.
4. The accumulated WebM is converted to 16 kHz mono WAV (ffmpeg) and
   transcribed by whisper.cpp (tiny.en, offline).
5. `respond.js` matches the transcript and picks a reply:
   - greeting/confirmation → "Great, thank you."
   - "Is that everything?" / "Anything else?" → "Yes, that's everything. Thanks so much!"
   - "What room?" → "Room 6131."
   - "What's your name?" → "Chris Dyer."
   - a wait time ("20 minutes") → "Perfect, thank you so much!"
   - "We don't have X" → "Oh, no problem — just skip that one, thanks."
   - "Can you repeat that?" → replay the order audio.
   - goodbye / "Thank you" → "Thank you so much! Have a great night!" then hang up.
   - anything unrecognized → "Sorry, could you repeat that?"
   - empty/noise → stay silent, keep listening (never spam).
6. The reply (a pre-generated Chatty Porch MP3) plays into the fake
   mic. Loop until goodbye or ~90 s, then hang up.

The closing is "That's everything. Thanks so much!" — no "how long"
question (a one-way call can't hear the answer, and a two-way call
lets the staff volunteer the time, which gets a "Perfect, thank you").

## FreeCallMe verification (how the OTP code/link gets to the runner)

The runner is ephemeral — no persistent FreeCallMe session. Every live
call signs in fresh (email OTP: Supabase sends a 6-digit code or a
magic link to cgd2049@gmail.com). The verification flow (mirrors the
old TextNow code flow, but via Firebase because there is no local
server on the runner):

1. The runner fills the dialer, presses Call now, and the FreeCallMe
   sign-in modal appears. It enters cgd2049@gmail.com; FreeCallMe
   emails a 6-digit OTP code (or a magic link) to Gmail. The runner
   marks the Firebase order `waiting-for-code` and polls the order
   node for a `code` field.
2. The parent (main agent) sees `waiting-for-code`, reads Gmail for
   the 6-digit code (or the magic-link URL), and writes it to the
   Firebase order node (`code: "123456"` or `code: "https://..."`).
3. The runner picks it up — enters the code, or opens the magic link
   — and continues. Up to 3 attempts.
No credential is hardcoded. The code/link is never logged.

Alternatively, pass `--code 123456` (or a magic-link URL, or
`FREECALLME_CODE`) when triggering manually if it is already known.

Note: the Gmail connector must be connected/reauthorized for the
parent to read the OTP. If Gmail reads fail with
`reauthorization_required`, reauthorize Gmail first — the runner will
wait at `waiting-for-code` until the code/link is written.

## Order audio (Chatty Porch)

The order script is dynamic (depends on the items), so the runner
cannot use a pre-generated file for it. The parent synthesizes the
order script with Chatty Porch on the home VM (`/opt/hatch/bin/tts`,
voice `avocado_v2:vdc_23184`) and writes the base64 MP3 to the Firebase
order node as `orderAudioB64` before the run. The runner prefers
`orderAudioB64`; if it is absent it falls back to `--order-audio`
(a local MP3 file), then to espeak-ng (robotic — last resort only).

The 8 rule-based replies are pre-generated Chatty Porch MP3s in
`audio/` and committed to the repo, so the runner never needs to
synthesize a reply on the fly.

## Deploy (what the parent/Chris does)

The subagent that built this has no GitHub push access, so deployment
is a manual step. Two files/dirs go into the repo
`GravyShooter/cancun-resort-map`:

1. Copy the whole `hailmary-gha/` directory into the repo root
   (so the repo has `hailmary-gha/gha-call.js`, `hailmary-gha/audio/`,
   `hailmary-gha/.github/workflows/*.yml`, etc.).
   Do NOT commit `node_modules/`, `.browser-profile/`, or
   `whisper.cpp/` (see `.gitignore`).
2. Commit + push. GitHub Actions picks up the workflows.

Then, in order:

### Step 1 — verify the host (do this first)
GitHub web UI → Actions → "WebRTC host test" → Run workflow.
It should report `HOST CHECK: PASS`. That proves the runner supports
WebRTC media (UDP, TURN, two-peer audio). If it FAILS, stop — the host
does not work and the call cannot run there (report the log).

### Step 2 — dry-run the two-way loop
Actions → "Room service call (two-way)" → Run workflow → set
`dry_run: true` (leave `order_id` empty; the dry-run uses
`sample-order.json` and a simulated staff peer). It verifies the
full listen→transcribe→respond→speak cycle on the runner and uploads
`result.json` as an artifact. It must PASS before any live call.

### Step 3 — first live call
1. Build the order on the order page (or write it to Firebase node
   `hailmary-orders-2way` with `status: "queued"`,
   `dryRun: false`, `language: "en"`).
2. The parent synthesizes the order script with Chatty Porch and
   writes the base64 MP3 to the order as `orderAudioB64`.
3. Trigger the workflow (Actions → Run workflow, or wait for the
   5-minute schedule). If the run reports `waiting-for-code`, the
   parent reads Gmail for the 6-digit code and writes it to the
   Firebase order as `code`.
4. The run dials, converses, hangs up, and writes the transcript +
   outcome back to Firebase (status `done`/`failed`). The order page
   shows it.

## Verified locally (this VM, Nov 6 2026)

- All JS files pass `node --check`; both workflow YAML files parse.
- Responder: 12/12 sample staff lines map to the correct reply.
- Script builder: produces the natural script with the clean closing
  ("That's everything. Thanks so much!", no "how long" question).
- ffmpeg converts the remote WebM chunks to 16 kHz mono WAV
  (verified: 16000 Hz, 1 channel).
- All 11 Chatty Porch MP3s are valid (8 replies + 3 staff test
  utterances), voice confirmed `avocado_v2:vdc_23184`.
- Host check correctly FAILS on this VM (UDP EPERM, 0 relay
  candidates) — the test logic is sound; it should PASS on a
  GitHub Actions runner, where UDP is allowed by default and there
  is no TLS-intercepting egress proxy.

## NOT verified yet (needs the GitHub Actions run)

- The host check actually PASSING on a GitHub Actions runner.
- whisper.cpp building + the tiny model downloading on the runner.
- The dry-run loop (simulated staff peer → Whisper → responder →
  reply) on the runner.
- A live FreeCallMe sign-in + dial + two-way conversation from the runner.
- The Firebase verification flow end-to-end (runner waits, parent writes code/link).

These are verified by Step 1 and Step 2 above before any live call.

## Cost

$0. GitHub Actions is free for public repos. FreeCallMe's first call
is free up to $0.25 (Mexico $0.03/min, US $0.01/min) — no card.
whisper.cpp is free and offline. No paid accounts, no top-ups,
no per-minute charges, no API keys.
