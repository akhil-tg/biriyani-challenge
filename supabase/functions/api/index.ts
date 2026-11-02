/* api/index.ts — Supabase Edge Function version of the Biriyani Challenge API.
 *
 * Same routes and handlers as the old Cloudflare worker (shared modules in
 * ../_shared), same HMAC session tokens and same Supabase tables. Adds CORS
 * headers so the static pages on GitHub Pages (a different origin) can call
 * it, and keeps the per-isolate login rate limiter.
 *
 * Live URL: https://acsauaywkyriukmpkjnt.supabase.co/functions/v1/api/<route>
 * Secrets needed: SUPABASE_URL, SUPABASE_KEY (service role), AUTH_SECRET.
 */
import { initSupa, restApi, resolveUser } from '../_shared/rest-api.mjs';

const SESSION_HEADER = 'authorization';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-client-info, apikey',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400',
};

/* ---------- best-effort login rate limiting (per isolate) ---------- */
const WINDOW_MS = 60000;        // rolling window
const MAX_FAILS = 10;           // failures allowed per window
const BLOCK_MS = 15 * 60000;    // block duration after too many failures
const attempts = new Map();     // ip -> { fails, windowStart, blockedUntil }

function rateBlocked(ip: string) {
  const e = attempts.get(ip);
  return !!(e && e.blockedUntil && e.blockedUntil > Date.now());
}

function noteFailure(ip: string) {
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

function noteSuccess(ip: string) { attempts.delete(ip); }

/* ---------- plumbing ---------- */
function json(obj: unknown, code = 200) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}

/* route lookup — mirrors worker.js */
function matchApi(method: string, pathname: string) {
  const route = method + ' ' + pathname;
  for (const k of Object.keys(restApi)) {
    if (k === route) return { key: k, id: null };
    if (k.includes('/:id')) {
      const parts = (k as string).split('/:id');
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('^' + esc(parts[0]) + '/(\\d+)' + (parts[1] ? esc(parts[1]) : '') + '$');
      const m = route.match(pattern);
      if (m) return { key: k, id: parseInt(m[1], 10) };
    }
  }
  return null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // CORS preflight (page origin is github.io, app origin here differ)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // strip everything up to this function's mount point (/functions/v1/api)
  const raw = url.pathname;
  const idx = raw.indexOf('/api/');
  const pathname = idx >= 0 ? raw.slice(idx + 4) : (raw.endsWith('/api') ? '/' : raw);
  if (pathname === '/') return json({ ok: true, service: 'biriyani-api' }); // health ping

  const match = matchApi(req.method, pathname);
  if (!match) return json({ error: 'Not found' }, 404);

  try {
    initSupa({
      SUPABASE_URL: Deno.env.get('SUPABASE_URL') || 'https://acsauaywkyriukmpkjnt.supabase.co',
      // the Edge runtime auto-injects SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
      SUPABASE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_KEY') || '',
      AUTH_SECRET: Deno.env.get('AUTH_SECRET') || '',
    });

    const isWrite = req.method === 'POST';
    const handler = restApi[match.key];

    // brute-force damping on the login endpoint
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (match.key === 'POST /login' && rateBlocked(ip)) {
      return json({ error: 'Too many attempts — try again in a few minutes' }, 429);
    }

    const authHeader = req.headers.get(SESSION_HEADER) || '';
    const token = authHeader.match(/Bearer\s+(.+)/i)?.[1] || '';
    const user = await resolveUser(token);

    const body = isWrite ? await req.json().catch(() => ({})) : {};
    const out = await handler(body, user, url, match.id);

    if (match.key === 'POST /login') {
      if (out && out.ok) noteSuccess(ip); else noteFailure(ip);
    }

    return json(out);
  } catch (err) {
    console.error('API error on ' + raw + ':', (err as Error)?.message);
    return json({ error: 'Internal server error: ' + ((err as Error)?.message || 'unknown') }, 500);
  }
});
