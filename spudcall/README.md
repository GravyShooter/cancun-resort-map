# SpudCall Web — room-service caller for iPhone (Safari) + Android (Chrome)

No app install, no GitHub runner. A web order page + a bookmarklet that
injects the caller into the FreeCallMe / PopTox dialer page.

## Why a bookmarklet
A plain web page cannot inject JS into a cross-origin dialer page
(same-origin policy blocks it). The bookmarklet runs inside the dialer
page's own origin, so it can fill the number, click Call, override
getUserMedia with a fake mic, mute all remote audio, and drive the call
— the same automation the Android app does in its WebView, but in plain
Safari / Chrome on a real phone (real IP, so no datacenter Turnstile block).

## Files (upload this whole folder to the repo)
- `caller.html` — order page (menu, room, guest, notes, CALL buttons, bookmarklet)
- `spud-call.js` — the injected automation (loaded by the bookmarklet)
- `menu.json` — menu data (reference; caller.html embeds the menu)
- `audio/*.mp3` — Chatty Porch reply audio (ack, everything, goodbye, room, name, time_ack, skip, fallback)

## Deploy (parent: same upload path as SpudMaps)
Upload this `spudcall/` folder to repo `GravyShooter/cancun-resort-map`
so it lands at `spudcall/` in the repo root. GitHub Pages then serves:
- Order page: https://gravyshooter.github.io/cancun-resort-map/spudcall/caller.html
- Inject script: https://gravyshooter.github.io/cancun-resort-map/spudcall/spud-call.js
- Reply audio: https://gravyshooter.github.io/cancun-resort-map/spudcall/audio/<key>.mp3

The bookmarklet in caller.html loads spud-call.js from that GitHub Pages
URL, and spud-call.js resolves reply MP3s relative to its own URL — so
everything works once the folder is uploaded. No other config needed.

## How Chris uses it (test call)
1. Open the order page on the iPhone (Safari) or Android (Chrome).
2. Install the bookmarklet once (instructions on the page: iPhone Safari =
   copy the bookmarklet, bookmark any page, edit the bookmark, paste into
   the URL field; Android Chrome = same via bookmark edit; desktop = drag
   the purple link to the bookmarks bar).
3. Test order is pre-loaded: Chicken Fingers x1 + Coke x2, room 6131,
   guest Chris. Backend FreeCallMe is selected.
4. Tap CALL TEST NUMBER (+1 740-381-3531). It saves the order to Firebase
   and opens freecallme.com in a new tab.
5. On the dialer tab, tap the SpudCall bookmark. The caller takes over:
   logs in (password from Firebase freecallme-auth), dials the test number,
   plays the Chatty Porch order audio into the fake mic, listens for the
   staff, says goodbye, hangs up. Chris answers his own phone and confirms
   he hears the order.
6. Tap TEST PASSED on the order page — that unlocks CALL FRONT DESK.
7. Only then tap CALL FRONT DESK (+52 998 872 8500). If FreeCallMe fails,
   switch the backend to PopTox and retry (no login needed).

## Safety
- Front desk is LOCKED until testPassed=true in Firebase (set by TEST
  PASSED). spud-call.js also refuses to dial the front desk unless
  testPassed is true. Never calls +52 998 872 8500 before a test passes.
- No speakerphone, no noise: every audio/video element is muted and the
  remote track is routed through a zero-gain node. The user hears nothing.

## Audio (important)
- The order audio is the pre-generated Chatty Porch MP3 stored in Firebase
  (hailmary-orders-2way/-P5my-uyvJJfZz7Fkrpf, field orderAudioB64).
  spud-call.js plays that. When Chris changes the order, generate fresh
  Chatty Porch audio and write orderAudioB64 into that Firebase node
  before he taps CALL — otherwise the caller will NOT speak (it refuses
  to speak a stale/wrong order) and hangs up.
- Reply audio (goodbye etc.) is the hosted MP3s in audio/. The caller
  listens for staff speech by sound level only (AnalyserNode RMS, no
  transcription), so it cannot answer specific questions (room/name/time).
  It plays the order, then on the first staff utterance + 2.5s silence it
  plays goodbye and hangs up. If no staff speech is heard in 20s after
  the order, it hangs up. Max call 90s.
- If FreeCallMe shows a 6-digit code screen, spud-call.js polls Firebase
  freecallme-auth/code (and the order node's code) for up to 10 min.
  The parent reads the code from Gmail (cgd2049@gmail.com) and writes it
  there. That is the only manual relay that may be needed.

## Cost
$0. FreeCallMe free credit, PopTox free. No card, no paid service, no
Vapi, no TextNow.

## Verified (this build)
- spud-call.js and caller.html inline script pass `node --check`.
- Menu: 66 items in the page (65 from menu.json + Chicken Fingers).
- Firebase smoke test: order node readable (to +17403813531, room 6131,
  Chicken Fingers x1 + Coke x2, orderAudioB64 present ~113KB MP3,
  testPassed unset = front desk locked), freecallme-auth has a password.
- NOT verified on a real phone: the live dial + audio flow needs Chris's
  iPhone/Android test call. The bookmarklet + injection logic is the same
  proven code as the Android app's spud-inject.js, adapted for the browser.
