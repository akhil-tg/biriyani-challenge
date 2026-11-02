/* auth.js — PIN hashing + signed session tokens.
 *
 * Pure Web Crypto, so the exact same code runs on Cloudflare Workers and Node.
 *   PIN storage:  pbkdf2$<saltHex>$<hashHex>   (PBKDF2-SHA256, 100k iterations)
 *   Sessions:     bc-v1.<b64url(payload)>.<b64url(hmac-sha256)>, payload carries
 *                 {id, name, isAdmin, exp} and is signed with AUTH_SECRET.
 * The token itself is trusted statelessly; a per-request active-account check
 * in rest-api.js resolveUser() kills access for removed accounts immediately.
 */
'use strict';

const ITERATIONS = 100000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};
const b64url = bytes => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlDecode = s => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const tex = s => new TextEncoder().encode(String(s));

function timingSafe(a, b) {
  const A = tex(a), B = tex(b);
  const n = Math.max(A.length, B.length);
  let diff = A.length ^ B.length;
  for (let i = 0; i < n; i++) diff |= (A[i] || 0) ^ (B[i] || 0);
  return diff === 0;
}

/* ---------- PBKDF2 PIN hashing ---------- */
async function pinBits(pin, saltHex) {
  const key = await crypto.subtle.importKey('raw', tex(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: ITERATIONS },
    key, 256
  );
  return toHex(bits);
}

async function newPinHash(pin) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return 'pbkdf2$' + salt + '$' + await pinBits(String(pin), salt);
}

async function checkPin(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2' || !parts[1] || !parts[2]) return false;
  return timingSafe(parts[2], await pinBits(String(pin), parts[1]));
}

/* ---------- signed session tokens ---------- */
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', tex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
}

async function signSession(secret, claims) {
  const body = b64url(tex(JSON.stringify({
    id: Number(claims.id),
    name: String(claims.name || ''),
    isAdmin: !!claims.isAdmin,
    exp: Date.now() + SESSION_TTL_MS,
  })));
  const sig = b64url(await hmac(secret, tex('bc-v1.' + body)));
  return 'bc-v1.' + body + '.' + sig;
}

async function verifySession(secret, token) {
  const t = String(token || '').trim();
  const m = t.match(/^bc-v1\.([A-Za-z0-9\-_]+)\.([A-Za-z0-9\-_]+)$/);
  if (!m) return null;
  const expected = b64url(await hmac(secret, tex('bc-v1.' + m[1])));
  if (!timingSafe(m[2], expected)) return null;
  let claims = null;
  try { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[1]))); } catch { return null; }
  if (!claims || typeof claims.id !== 'number' || !claims.exp || claims.exp < Date.now()) return null;
  return claims;
}

module.exports = { newPinHash, checkPin, timingSafe, signSession, verifySession, SESSION_TTL_MS };
