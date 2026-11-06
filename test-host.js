// test-host.js — standalone WebRTC host check for GitHub Actions.
// Verifies the runner supports WebRTC media via the PulseAudio
// pipe-source mic: UDP socket, TURN ICE, and a two-peer connection
// where peer A uses the REAL mic (virtmic, fed live by the FIFO
// /tmp/virtmic), a tone is written into the pipe, and peer B's received
// audio is measured with MediaRecorder + ffmpeg volumedetect. Exit 0
// when media can flow, 1 when it cannot. Used by
// .github/workflows/webrtc-test.yml.
const { hostCheck } = require('./gha-call');
(async () => {
  const h = await hostCheck();
  console.log(JSON.stringify(h, null, 2));
  const ok = h.udpOk && h.twoPeerConnected && h.twoPeerRms > 0.005;
  console.log('mic=' + (h.micLabel || '?') + ' recvBytes=' + (h.recvBytes || 0) +
    ' meanDb=' + (h.recvDb === null || h.recvDb === undefined ? 'n/a' : (h.recvDb === -Infinity ? '-inf' : h.recvDb)) +
    ' recvRMS=' + (h.twoPeerRms || 0));
  console.log(ok ? 'HOST CHECK: PASS — WebRTC media can flow on this host (PulseAudio pipe-source mic).'
                 : 'HOST CHECK: FAIL — WebRTC media cannot flow on this host.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
