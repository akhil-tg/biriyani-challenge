/* shared-api.js — auth plumbing shared by worker.js (Cloudflare Workers).
 *
 * All data endpoints live in rest-api.js, which talks to the normalized
 * Supabase tables directly. This module only:
 *   - validates Supabase auth tokens (JWT decode + /auth/v1/user confirm)
 *   - resolves the coordinator profile bound to the token
 *   - passes /auth/login and /auth/refresh through to Supabase so the
 *     public frontend never needs an anon key
 */
'use strict';

/* ---- Supabase environment (worker env vars) ---- */
let ENV = {};
function supaHeaders(extra) {
  return Object.assign({
    'apikey': ENV.SUPABASE_KEY || '',
    'Authorization': 'Bearer ' + (ENV.SUPABASE_KEY || ''),
    'Content-Type': 'application/json',
  }, extra || {});
}

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

const restDb = require('./rest-api.js');

/* cache of validated Supabase auth tokens (token -> {id,email,name,exp}) */
const tokenCache = new Map();

async function fetchAuthUser(token) {
  const base = (ENV.SUPABASE_URL || '').replace(/\/+$/, '');
  const res = await fetch(base + '/auth/v1/user', {
    headers: { 'apikey': ENV.SUPABASE_KEY, 'Authorization': 'Bearer ' + token },
  });
  if (!res.ok) return null;
  return res.json();
}

/* Validate a Supabase Access JWT: decode payload, check exp, confirm with the
 * auth server (real signature validation happens there). */
async function resolveAuthUser(headers) {
  const auth = String(headers['authorization'] || headers['Authorization'] || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const cached = tokenCache.get(token);
  if (cached && (!cached.exp || cached.exp > Date.now() / 1000 + 30)) return cached;
  let payload = null;
  try { payload = JSON.parse(b64urlDecode(token.split('.')[1])); } catch { return null; }
  if (!payload || (payload.exp && payload.exp < Date.now() / 1000)) return null;
  const u = await fetchAuthUser(token);
  if (!u || !u.id) return null;
  const info = {
    id: u.id,
    email: (u.email || '').toLowerCase(),
    name: (u.user_metadata && u.user_metadata.name) || (u.email || '').split('@')[0],
    exp: payload.exp || 0,
  };
  tokenCache.set(token, info);
  if (tokenCache.size > 200) { const it = tokenCache.keys(); for (let i = 0; i < 100; i++) tokenCache.delete(it.next().value); }
  return info;
}

/* Who is making this request? Authorization: Bearer <auth JWT> only —
 * the coordinator profile is resolved from the normalized tables via
 * rest-api.js (auto-provisioning the first login as the Admin). */
async function resolveUser(request) {
  const h = request.headers || {};
  const au = await resolveAuthUser(h);
  if (!au) return null;
  if (!restDb.ready()) restDb.initSupa(ENV);
  return await restDb.resolveCoordinator(au);
}

/* ---------------- api ---------------- */
const api = {};

/* Supabase auth passthrough */
api['POST /auth/login'] = async b => {
  if (!ENV.SUPABASE_URL || !ENV.SUPABASE_KEY) return { error: 'Auth backend not configured' };
  const email = (b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!email || !password) return { error: 'Email and password required' };
  const res = await fetch((ENV.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: supaHeaders(),
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (body.error_description || body.msg || body.message || 'Login failed') };
  return { ok: true, access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at };
};

api['POST /auth/refresh'] = async b => {
  if (!ENV.SUPABASE_URL || !ENV.SUPABASE_KEY) return { error: 'Auth backend not configured' };
  if (!b.refresh_token) return { error: 'Refresh token required' };
  const res = await fetch((ENV.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: supaHeaders(),
    body: JSON.stringify({ refresh_token: b.refresh_token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (body.error_description || body.msg || body.message || 'Session expired') };
  return { ok: true, access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at };
};

module.exports = {
  api, get restApi() { return restDb.restApi; }, setEnv, resolveUser,
  initRest: () => { if (ENV.SUPABASE_URL && ENV.SUPABASE_KEY && !restDb.ready()) restDb.initSupa(ENV); },
};
