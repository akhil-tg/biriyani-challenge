/* worker.js — Cloudflare Workers port of the Biriyani Challenge server.
 *
 * Storage: Supabase `app_state` table (the exact same JSON blob server.js
 * uses). Per request:
 *   - GET requests use a short in-memory cache (isolate-local) to avoid
 *     hammering Supabase from the frontend's polling loops.
 *   - POST requests always load the freshest data first, mutate, then
 *     persist with an upsert before replying.
 * Static pages (public/*) are served by the ASSETS binding; the worker adds
 * a clean-URL fallback (/order -> /order.html).
 */
import shared from './shared-api.js';

const { api, setSave, setSetupLocked, setEnv, hydrate, getDb } = shared;

// Cloudflare deployments are always Supabase-backed -> admin comes from Supabase only
setSetupLocked(true);

const READ_CACHE_MS = 2000; // max staleness for GET requests
let lastLoad = 0;           // ms timestamp of the last Supabase load (per isolate)
let lastLoadedBody = '';    // tiny integrity guard

function supaHeaders(env, extra) {
  const h = {
    'apikey': env.SUPABASE_KEY,
    'Authorization': 'Bearer ' + (env.SUPABASE_KEY || ''),
    'Content-Type': 'application/json',
  };
  return Object.assign(h, extra || {});
}

async function loadFromSupa(env) {
  const res = await fetch(
    (env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/app_state?id=eq.1&select=data',
    { headers: supaHeaders(env) }
  );
  if (!res.ok) throw new Error('Supabase load ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const rows = await res.json();
  hydrate(rows.length && rows[0].data ? rows[0].data : {});
  lastLoad = Date.now();
}

async function saveToSupa(env) {
  const res = await fetch(
    (env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/app_state',
    {
      method: 'POST', // upsert thanks to merge-duplicates
      headers: supaHeaders(env, { 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify({ id: 1, data: getDb() }),
    }
  );
  if (!res.ok) throw new Error('Supabase save ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

async function readJson(request) {
  try { const t = await request.text(); return t ? JSON.parse(t) : {}; }
  catch { return {}; }
}

function json(obj, code = 200) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* route lookup — same logic as server.js */
function matchApi(method, pathname) {
  const route = method + ' ' + pathname.slice(4); // strip '/api'
  for (const k of Object.keys(api)) {
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
    setEnv(env); // per-request, rooms the worker's secrets into the shared API
    shared.initRest(); // normalized-table layer must be ready for every route
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      return cleanUrl(request, env, url);
    }

    const match = matchApi(request.method, url.pathname);
    if (!match) return json({ error: 'Not found' }, 404);

    try {
      const isWrite = request.method === 'POST';
      const h = shared.restApi[match.key] || shared.api[match.key];
      const useRest = !!shared.restApi[match.key];

      if (!useRest && (isWrite || (Date.now() - lastLoad) > READ_CACHE_MS)) {
        await loadFromSupa(env); // legacy blob mode: writes always see fresh data
      }

      const user = await shared.resolveUser({
        headers: {
          'x-user': request.headers.get('x-user') || '',
          'authorization': request.headers.get('authorization') || '',
        },
      });
      const body = isWrite ? await readJson(request) : {};

      // REST deployments (locked) go straight to the normalized tables;
      // the legacy blob handlers remain only for file deployments.
      const out = await h(body, user, url, match.id);

      if (isWrite) {
        await saveToSupa(env); // persist BEFORE the response goes out
      }
      return json(out);
    } catch (err) {
      console.error('API error on ' + url.pathname + ':', err && err.message);
      return json({ error: 'Internal server error: ' + (err && err.message) }, 500);
    }
  },
};
