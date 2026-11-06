// test-host.js — standalone WebRTC host check for GitHub Actions.
// Verifies the runner supports WebRTC media (UDP socket, TURN ICE,
// two-peer connection). Exit 0 when media can flow, 1 when it cannot.
// Used by .github/workflows/webrtc-test.yml.
const { hostCheck } = require('./gha-call');
(async () => {
  const h = await hostCheck();
  console.log(JSON.stringify(h, null, 2));
  const ok = h.udpOk && h.twoPeerConnected && h.twoPeerRms > 0.005;
  console.log(ok ? 'HOST CHECK: PASS — WebRTC media can flow on this host.'
                 : 'HOST CHECK: FAIL — WebRTC media cannot flow on this host.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
