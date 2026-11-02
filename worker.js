/* worker.js — Cloudflare Workers server for the Biriyani Challenge.
 *
 * Storage: normalized Supabase tables (coordinators, items, orders) via
 * rest-api.js — every data endpoint talks to Supabase REST directly.
 * Static pages (public/*) are served by the ASSETS binding; the worker adds
 * a clean-URL fallback (/order -> /order.html).
 */
import shared from './shared-api.js';

const { api, restApi, setEnv, resolveUser } = shared;

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
  for (const k of Object.keys(restApi).concat(Object.keys(api))) {
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
    setEnv(env); // puts the worker's secrets into the shared API
    shared.initRest(); // REST-table layer must be ready for every route
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
      const handler = restApi[match.key] || api[match.key];
      if (!handler) return json({ error: 'Not found' }, 404);

      const user = await resolveUser({
        headers: { 'authorization': request.headers.get('authorization') || '' },
      });
      const body = isWrite ? await readJson(request) : {};

      const out = await handler(body, user, url, match.id);
      return json(out);
    } catch (err) {
      console.error('API error on ' + url.pathname + ':', err && err.message);
      return json({ error: 'Internal server error: ' + (err && err.message) }, 500);
    }
  },
};
