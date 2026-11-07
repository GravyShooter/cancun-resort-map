// firebase.js — Firebase Realtime Database REST helper for the
// GitHub Actions two-way caller. No SDK, plain fetch. Anonymous
// sign-in via Identity Toolkit (same as the order page and the
// SpudMaps map). The Firebase web API key is a client-side key —
// it is fetched at runtime from the public map page (never
// hardcoded here), or taken from FIREBASE_API_KEY.
//
//   const fb = require('./firebase');
//   const { apiKey, idToken } = await fb.auth();
//   const order = await fb.readOrder(orderId, idToken);
//   await fb.patchOrder(orderId, idToken, { status: 'done', transcript });

const DB_URL = 'https://excellence-riviera-cancu-12f14-default-rtdb.firebaseio.com';
const MAP_URL = 'https://gravyshooter.github.io/cancun-resort-map/';
// Default node is the one-way queue. Two-way calls use a separate node
// (hailmary-orders-2way) so the one-way watcher on the VM never claims
// them. Override with FIREBASE_NODE.
const NODE = process.env.FIREBASE_NODE || 'hailmary-orders';

async function getApiKey() {
  if (process.env.FIREBASE_API_KEY) return process.env.FIREBASE_API_KEY;
  const res = await fetch(MAP_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('could not fetch map page for Firebase API key (HTTP ' + res.status + ')');
  const html = await res.text();
  const m = html.match(/apiKey\s*:\s*["']([^"']+)["']/);
  if (!m) throw new Error('Firebase apiKey not found in map page HTML');
  return m[1];
}

async function signInAnonymously(apiKey) {
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(apiKey),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.idToken) throw new Error('anonymous sign-in failed: ' + JSON.stringify(body).slice(0, 200));
  return body.idToken;
}

async function auth() {
  const apiKey = await getApiKey();
  const idToken = await signInAnonymously(apiKey);
  return { apiKey, idToken };
}

function orderUrl(orderId, idToken) {
  return DB_URL + '/' + NODE + '/' + encodeURIComponent(orderId) + '.json?auth=' + encodeURIComponent(idToken);
}

async function readOrder(orderId, idToken) {
  const res = await fetch(orderUrl(orderId, idToken), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('read order failed (HTTP ' + res.status + ')');
  return res.json();
}

async function patchOrder(orderId, idToken, patch) {
  const res = await fetch(orderUrl(orderId, idToken), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('patch order failed (HTTP ' + res.status + ')');
  return res.json().catch(() => ({}));
}

// Poll the order node until a `code` field appears (the parent writes
// the login verification there after reading Gmail). The value is
// EITHER a 6-digit OTP code OR a magic-link URL (Supabase sends one
// or the other). Returns it as-is, or throws on timeout. The value is
// never logged.
async function waitForCode(orderId, idToken, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10 * 60 * 1000);
  for (;;) {
    try {
      const order = await readOrder(orderId, idToken);
      const code = order && order.code;
      if (typeof code === 'string' && (/^\d{6}$/.test(code) || /^https?:\/\/\S+$/.test(code))) return code;
    } catch (e) { /* transient read failure — keep waiting */ }
    if (Date.now() > deadline) throw new Error('timed out waiting for the login verification (code or magic link) in Firebase');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// FreeCallMe account password, persisted across ephemeral runner runs
// in a dedicated node (freecallme-auth). The account holds no payment
// method (free $0.25 credit only), so this is low-stakes. Prefer the
// FREECALLME_PASSWORD env var (GitHub secret) when set.
const AUTH_NODE = 'freecallme-auth';
async function readAuthPassword(idToken) {
  const res = await fetch(DB_URL + '/' + AUTH_NODE + '.json?auth=' + encodeURIComponent(idToken), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body && body.password;
}
async function writeAuthPassword(idToken, password) {
  const res = await fetch(DB_URL + '/' + AUTH_NODE + '.json?auth=' + encodeURIComponent(idToken), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error('write auth password failed (HTTP ' + res.status + ')');
  return res.json().catch(() => ({}));
}

module.exports = { DB_URL, NODE, getApiKey, signInAnonymously, auth, readOrder, patchOrder, waitForCode, readAuthPassword, writeAuthPassword };
