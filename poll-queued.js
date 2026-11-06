// poll-queued.js — find the oldest queued two-way order in Firebase.
// Used by the scheduled GitHub Actions run: the workflow polls the
// two-way node (hailmary-orders-2way) every 5 minutes and processes
// any order with status "queued". Prints the order ID (or nothing
// when there is no queued order) and exits 0 either way; exits 1 on
// a Firebase/auth error.
//   node poll-queued.js   -> prints "<orderId>" or "" (empty = none)
const fb = require('./firebase');
(async () => {
  const { idToken } = await fb.auth();
  const url = fb.DB_URL + '/' + (process.env.FIREBASE_NODE || 'hailmary-orders-2way') + '.json?auth=' + encodeURIComponent(idToken);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('read orders failed (HTTP ' + res.status + ')');
  const all = (await res.json()) || {};
  const queued = Object.entries(all)
    .filter(([, o]) => o && o.status === 'queued')
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  if (!queued.length) { console.log(''); return; }
  console.log(queued[0][0]);
})().catch((e) => { console.error('POLL ERROR:', e.message); process.exit(1); });
