/* worker.js — Cloudflare Workers server for the Biriyani Challenge.
 *
 * Auth model: name + 6-digit PIN (admins and coordinators both live in the
 * coordinators table; the admin rows have is_admin=true). Login issues an
 * HMAC-signed session token (auth.js) using the AUTH_SECRET secret; every
 * request is verified statelessly, then re-checked against the account's
 * active flag so removed accounts lose access immediately.
 *
 * Storage: normalized Supabase tables via rest-api.js.
 * Static pages (public/*) are served by the ASSETS binding; the worker adds
 * a clean-URL fallback (/order -> /order.html).
 */
import rest from './rest-api.js';
import auth from './auth.js';

const { restApi, resolveUser, initSupa } = rest;

const SESSION_HEADER = 'authorization';

/* ---------- best-effort login rate limiting (per isolate) ---------- */
const WINDOW_MS = 60000;        // rolling window
const MAX_FAILS = 10;           // failures allowed per window
const BLOCK_MS = 15 * 60000;    // block duration after too many failures
const attempts = new Map();     // ip -> { fails, windowStart, blockedUntil }

function rateBlocked(ip) {
  const e = attempts.get(ip);
  return !!(e && e.blockedUntil && e.blockedUntil > Date.now());
}

function noteFailure(ip) {
  if (attempts.size > 500) { // tiny prune: drop stale entries
    const cutoff = Date.now() - 2 * BLOCK_MS;
    for (const [k, e] of attempts) {
      if ((e.blockedUntil || 0) < cutoff && e.windowStart < cutoff) attempts.delete(k);
    }
  }
  let e = attempts.get(ip);
  const t = Date.now();
  if (!e || t - e.windowStart > WINDOW_MS) {
    e = { fails: 0, windowStart: t, blockedUntil: 0 };
    attempts.set(ip, e);
  }
  e.fails += 1;
  if (e.fails >= MAX_FAILS) e.blockedUntil = t + BLOCK_MS;
}

function noteSuccess(ip) { attempts.delete(ip); }

/* ---------- plumbing ---------- */
function readJson(request) {
  return request.text()
    .then(t => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } })
    .catch(() => ({}));
}

function json(obj, code = 200) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* route lookup */
function matchApi(method, pathname) {
  const route = method + ' ' + pathname.slice(4); // strip '/api'
  for (const k of Object.keys(restApi)) {
    if (k === route) return { key: k, id: null };
    if (k.includes('/:id')) {
      const parts = k.split('/:id');
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('^' + esc(parts[0]) + '/(\\d+)' + (parts[1] ? esc(parts[1]) : '') + '$');
      const m = route.match(pattern);
      if (m) return { key: k, id: parseInt(m[1], 10) };
    }
  }
  return null;
}

async function cleanUrl(request, env, url) {
  // worker came first because of run_worker_first, so on a 404 from the
  // asset pipeline try path + '.html' (e.g. /order -> /order.html)
  const fallback = await env.ASSETS.fetch(new Request(url.origin + url.pathname + '.html'));
  if (fallback.status !== 404) return fallback;
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      return cleanUrl(request, env, url);
    }

    const match = matchApi(request.method, url.pathname);
    if (!match) return json({ error: 'Not found' }, 404);

    try {
      initSupa(env); // puts SUPABASE_URL/KEY + AUTH_SECRET into the data layer

      const isWrite = request.method === 'POST';
      const handler = restApi[match.key];

      // brute-force damping on the login endpoint
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (match.key === 'POST /login' && rateBlocked(ip)) {
        return json({ error: 'Too many attempts — try again in a few minutes' }, 429);
      }

      const authHeader = request.headers.get(SESSION_HEADER) || '';
      const token = authHeader.match(/Bearer\s+(.+)/i)?.[1] || '';
      const user = await resolveUser(token);

      const body = isWrite ? await readJson(request) : {};
      const out = await handler(body, user, url, match.id);

      if (match.key === 'POST /login') {
        if (out && out.ok) noteSuccess(ip); else noteFailure(ip);
      }

      return json(out);
    } catch (err) {
      console.error('API error on ' + url.pathname + ':', err && err.message);
      return json({ error: 'Internal server error: ' + (err && err.message) }, 500);
    }
  },
};
