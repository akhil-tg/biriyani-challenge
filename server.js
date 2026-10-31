/* Biriyani Challenge — Order Tracker
 * Zero-dependency Node.js server (no npm install needed).
 * Runs the API + serves the frontend.
 * Storage: Supabase (`app_state` table) when SUPABASE_URL + SUPABASE_KEY env
 * are set, otherwise the local file data/db.json.
 * The API handlers live in shared-api.js (shared with worker.js).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const shared = require('./shared-api.js');
const { api, setSave, setSetupLocked, setEnv, hydrate } = shared;

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

/* ---------------- storage ----------------
 *  - SUPABASE_URL + SUPABASE_KEY env set  -> the whole dataset lives as one
 *    JSON blob in the Supabase table `app_state` (durable, survives restarts).
 *  - otherwise -> classic data/db.json file (local laptop use).
 */
const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_KEY || '';
const SUPA_ON = !!(SUPA_URL && SUPA_KEY);

// Supabase-backed -> admin must be provisioned via Supabase Authentication, not via the web
setSetupLocked(SUPA_ON);

// expose the env to the shared API (auth resolution / Supabase admin calls)
setEnv({
  SUPABASE_URL: SUPA_URL,
  SUPABASE_KEY: SUPA_KEY,
});

let saveTimer = null;
let saving = false;        // a Supabase push is in flight
let dirtyAgain = false;    // data changed while a push was running

async function flushSave() {
  if (SUPA_ON) {
    if (saving) { dirtyAgain = true; return; }
    saving = true;
    try {
      const res = await fetch(SUPA_URL + '/rest/v1/app_state', {
        method: 'POST', // upsert thanks to merge-duplicates
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': 'Bearer ' + SUPA_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ id: 1, data: shared.getDb() }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error('Supabase save failed (' + res.status + '): ' + text.slice(0, 300));
      }
    } catch (e) {
      console.error('Supabase save error: ' + e.message);
    }
    saving = false;
    if (dirtyAgain) { dirtyAgain = false; await flushSave(); }
  } else {
    // debounce writes so bursts of orders don't thrash the disk
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(shared.getDb(), null, 1));
    fs.renameSync(tmp, DATA_FILE);
  }
}

function save() {
  // debounce writes so bursts of orders don't thrash the disk (file) / the API (Supabase)
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, 200);
}
setSave(save);

async function load() {
  if (SUPA_ON) {
    console.log('Storage: Supabase (' + SUPA_URL + ')');
    try {
      const res = await fetch(SUPA_URL + '/rest/v1/app_state?id=eq.1&select=data', {
        headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY },
      });
      if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 300));
      const rows = await res.json();
      hydrate(rows.length && rows[0].data ? rows[0].data : {});
      if (!rows.length) console.log('Supabase: app_state is empty, starting fresh');
    } catch (e) {
      console.error('Supabase load FAILED, using empty data. Check the app_state table / keys: ' + e.message);
      hydrate({});
    }
  } else {
    console.log('Storage: local file ' + DATA_FILE);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let parsed = {};
    if (fs.existsSync(DATA_FILE)) {
      try { parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {
        console.error('Could not parse db.json, starting fresh:', e.message);
      }
    }
    hydrate(parsed);
  }
}

/* ---------------- http ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const route = req.method + ' ' + pathname.slice(4);
    let handler = null;
    let id = null;

    for (const k of Object.keys(api)) {
      if (k === route) {
        handler = k;
        break;
      }
      if (k.includes('/:id')) {
        const parts = k.split('/:id');
        const escapedPrefix = parts[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedSuffix = parts[1] ? parts[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
        const pattern = new RegExp('^' + escapedPrefix + '/(\\d+)' + escapedSuffix + '$');
        const match = route.match(pattern);
        if (match) {
          handler = k;
          id = parseInt(match[1], 10);
          break;
        }
      }
    }

    if (!handler) return json(res, 404, { error: 'Not found' });
    const user = await shared.resolveUser({
      headers: {
        'x-user': req.headers['x-user'] || '',
        'authorization': req.headers['authorization'] || '',
      },
    });
    const body = req.method === 'POST' ? await readBody(req) : {};
    try {
      const out = await api[handler](body, user, url, id);
      json(res, 200, out);
    } catch (err) {
      console.error('API error on ' + route + ':', err);
      json(res, 500, { error: 'Internal server error: ' + err.message });
    }
    return;
  }

  // static files
  let file = pathname === '/' ? '/index.html' : pathname;
  file = file.replace(/\\/g, '/');
  let fp = path.join(PUBLIC, file);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }

  // support clean URLs (e.g. /order -> /order.html)
  if (!path.extname(fp) && !fs.existsSync(fp) && fs.existsSync(fp + '.html')) {
    fp = fp + '.html';
  }

  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
});

(async () => {
  await load();
  server.listen(PORT, () => {
    console.log('==============================================');
    console.log('  Biriyani Challenge — Order Tracker running!');
    console.log('  On this laptop :  http://localhost:' + PORT);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log('  On phones      :  http://' + net.address + ':' + PORT);
        }
      }
    }
    console.log('==============================================');
    console.log('First time? Open the app in your browser - it will ask you to create the Admin, or you can click "Load demo data" to try it out.');
  });
})();
