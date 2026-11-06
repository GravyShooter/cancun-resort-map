// test-host.js — standalone WebRTC host check for GitHub Actions.
// Verifies the runner supports WebRTC media via the pipe-source mic
// (or the pw-loopback mic on PipeWire): UDP socket, TURN ICE, and a
// two-peer connection where peer A uses the REAL mic (virtmic), a tone
// is written into the feed, and peer B's received audio is measured
// with MediaRecorder + ffmpeg volumedetect. Also records virtmic
// directly with parec (micRecDb/micRecRMS) to prove whether the mic
// source itself carries audio, independent of WebRTC. Exit 0 when
// media can flow, 1 when it cannot. Used by
// .github/workflows/webrtc-test.yml.
const { hostCheck } = require('./gha-call');
(async () => {
  const h = await hostCheck();
  console.log(JSON.stringify(h, null, 2));
  const ok = h.udpOk && h.twoPeerConnected && h.twoPeerRms > 0.005;
  console.log('mic=' + (h.micLabel || '?') + ' recvBytes=' + (h.recvBytes || 0) +
    ' meanDb=' + (h.recvDb === null || h.recvDb === undefined ? 'n/a' : (h.recvDb === -Infinity ? '-inf' : h.recvDb)) +
    ' recvRMS=' + (h.twoPeerRms || 0) +
    ' micRecDb=' + (h.micRecDb === null || h.micRecDb === undefined ? 'n/a' : (h.micRecDb === -Infinity ? '-inf' : h.micRecDb)) +
    ' micRecRMS=' + (h.micRecRms || 0));
  console.log(ok ? 'HOST CHECK: PASS — WebRTC media can flow on this host (pipe-source/pw-loopback mic).'
                 : 'HOST CHECK: FAIL — WebRTC media cannot flow on this host.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
