/* Biriyani Challenge — Order Tracker
 * Zero-dependency Node.js server (no npm install needed).
 * Runs the API + serves the frontend. Data stored in data/db.json
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

/* ---------------- storage ---------------- */
let db = { coordinators: [], items: [], orders: [], counters: { order: 0, token: 0 } };
let saveTimer = null;

function save() {
  // debounce writes so bursts of orders don't thrash the disk
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {
      console.error('Could not parse db.json, starting fresh:', e.message);
    }
  }
  db.coordinators = db.coordinators || [];
  db.items = db.items || [];
  db.orders = db.orders || [];
  db.counters = db.counters || { order: 0, token: 0 };
}
load();

/* ---------------- helpers ---------------- */
const now = () => new Date().toISOString();
const pad = (n, w) => String(n).padStart(w, '0');

function publicUser(c) {
  return c ? { id: c.id, name: c.name, isAdmin: !!c.isAdmin, active: !!c.active } : null;
}
function findCoordinatorByAuth(req) {
  const uid = parseInt(req.headers['x-user'], 10) || null;
  if (!uid) return null;
  return db.coordinators.find(c => c.id === uid && c.active) || null;
}
function findOrder(id) {
  return db.orders.find(o => o.id === id) || null;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

/* ---------------- api ---------------- */
const api = {};

api['GET /status'] = () => ({
  needSetup: !db.coordinators.some(c => c.active && c.isAdmin),
  hasData: db.coordinators.length > 0 || db.orders.length > 0,
});

// first-run: create the first admin (only allowed while no admin exists)
api['POST /setup'] = b => {
  if (db.coordinators.some(c => c.active && c.isAdmin)) return { error: 'Setup already done' };
  const name = (b.name || '').trim();
  const pin = (b.pin || '').trim();
  if (!name || !/^\d{4}$/.test(pin)) return { error: 'Name and 4-digit PIN required' };
  const c = { id: 1, name, pin, isAdmin: true, active: true, createdAt: now() };
  db.coordinators.push(c); save();
  return { ok: true, user: publicUser(c) };
};

api['POST /login'] = b => {
  const name = (b.name || '').trim().toLowerCase();
  const pin = (b.pin || '').trim();
  const c = db.coordinators.find(
    x => x.active && x.name.toLowerCase() === name && String(x.pin) === pin
  );
  return c ? { ok: true, user: publicUser(c) } : { ok: false, error: 'Wrong name or PIN' };
};

api['GET /coordinators'] = (b, user) => {
  if (!user) return { error: 'Login required' };
  return { coordinators: db.coordinators.filter(c => c.active).map(publicUser) };
};

api['POST /coordinators'] = (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const name = (b.name || '').trim();
  const pin = (b.pin || '').trim();
  if (!name || !pin) return { error: 'Name and PIN required' };
  if (db.coordinators.some(c => c.active && c.name.toLowerCase() === name.toLowerCase()))
    return { error: 'Name already exists' };
  const maxCoordId = db.coordinators.reduce((m, x) => Math.max(m, x.id || 0), 0);
  const c = { id: maxCoordId + 1, name, pin, isAdmin: !!b.isAdmin, active: true, createdAt: now() };
  db.coordinators.push(c); save();
  return { ok: true, coordinator: publicUser(c) };
};

api['POST /coordinators/remove'] = (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const c = db.coordinators.find(x => x.id === b.id);
  if (c) { c.active = false; save(); }
  return { ok: true };
};

api['GET /items'] = () => ({ items: db.items.filter(i => i.active) });

api['POST /items'] = (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const name = (b.name || '').trim();
  const price = Math.max(0, Number(b.price) || 0);
  if (!name) return { error: 'Name required' };
  const maxItemId = db.items.reduce((m, i) => Math.max(m, i.id || 0), 0);
  const maxOrder = db.items.reduce((m, i) => Math.max(m, i.order || 0), 0);
  const item = { id: maxItemId + 1, name, price, order: maxOrder + 1, active: true };
  db.items.push(item); save();
  return { ok: true, item };
};

api['POST /items/update'] = (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const item = db.items.find(i => i.id === b.id);
  if (!item) return { error: 'Not found' };
  if (b.name != null) item.name = String(b.name).trim();
  if (b.price != null) item.price = Math.max(0, Number(b.price) || 0);
  save();
  return { ok: true, item };
};

api['POST /items/remove'] = (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const item = db.items.find(i => i.id === b.id);
  if (item) { item.active = false; save(); }
  return { ok: true };
};

api['POST /orders'] = (b, user) => {
  if (!user) return { error: 'Login required' };
  const cust = b.customer || {};
  const items = Array.isArray(b.items) ? b.items.filter(i => i.qty > 0) : [];
  if (!items.length) return { error: 'Add at least one item' };
  const custName = (cust.name || '').trim();
  if (!custName) return { error: 'Customer name required' };

  // validate against menu, snapshot price
  const snapshot = [];
  let total = 0;
  for (const it of items) {
    const menu = db.items.find(m => m.id === it.itemId && m.active);
    if (!menu) return { error: 'Unknown item' };
    const qty = Math.max(1, Math.floor(Number(it.qty) || 0));
    snapshot.push({ itemId: menu.id, name: menu.name, price: menu.price, qty });
    total += menu.price * qty;
  }

  db.counters.token += 1;
  db.counters.order += 1;
  const order = {
    id: db.counters.order,
    tokenNo: db.counters.token,
    takenBy: user.id,
    takenByName: user.name,
    customer: {
      name: custName,
      phone: (cust.phone || '').trim(),
      place: (cust.place || '').trim(),
      address: (cust.address || '').trim(),
    },
    items: snapshot,
    total,
    status: 'pending',
    cashCollected: null,
    deliveredBy: null,
    deliveredByName: null,
    deliveredAt: null,
    createdAt: now(),
  };
  db.orders.push(order); save();
  return { ok: true, order };
};

api['GET /orders'] = (b, user, url) => {
  if (!user) return { error: 'Login required' };
  const q = url ? url.searchParams : new URLSearchParams();
  let list = db.orders.slice(); // on the wire newest-first? will sort
  const status = q.get('status');
  if (status === 'pending') list = list.filter(o => o.status === 'pending');
  if (status === 'delivered') list = list.filter(o => o.status === 'delivered');
  return {
    orders: list.sort((a, b) => b.id - a.id).slice(0, 500),
    coordinators: db.coordinators.filter(c => c.active).map(publicUser),
  };
};

api['GET /orders/:id'] = (b, user, url, id) => {
  if (!user) return { error: 'Login required' };
  const o = findOrder(id);
  return o ? { order: o } : { error: 'Order not found' };
};

api['POST /orders/:id/deliver'] = (b, user, url, id) => {
  if (!user) return { error: 'Login required' };
  const o = findOrder(id);
  if (!o) return { error: 'Order not found' };
  if (o.status === 'delivered') return { error: 'Already delivered' };
  let cash = b.cash == null || b.cash === '' ? o.total : Number(b.cash);
  if (!(cash >= 0)) cash = o.total;
  o.status = 'delivered';
  o.cashCollected = Math.round(cash);
  o.deliveredBy = user.id;
  o.deliveredByName = user.name;
  o.deliveredAt = now();
  save();
  return { ok: true, order: o };
};

// admin: fix/delete a pending order or adjust cash on delivered order
api['POST /orders/:id/update'] = (b, user, url, id) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const o = findOrder(id);
  if (!o) return { error: 'Order not found' };
  if (b.delete) {
    db.orders = db.orders.filter(x => x.id !== o.id);
    save();
    return { ok: true, deleted: true };
  }
  if (o.status === 'pending') {
    if (b.items) {
      const snapshot = [];
      let total = 0;
      for (const it of b.items) {
        const menu = db.items.find(m => m.id === it.itemId && m.active);
        const qty = Math.max(1, Math.floor(Number(it.qty) || 0));
        if (menu && qty > 0) { snapshot.push({ itemId: menu.id, name: menu.name, price: menu.price, qty }); total += menu.price * qty; }
      }
      if (snapshot.length) { o.items = snapshot; o.total = total; }
    }
    if (b.customer) {
      const c = b.customer;
      o.customer = {
        name: c.name != null ? String(c.name).trim() : o.customer.name,
        phone: c.phone != null ? String(c.phone).trim() : o.customer.phone,
        place: c.place != null ? String(c.place).trim() : o.customer.place,
        address: c.address != null ? String(c.address).trim() : o.customer.address,
      };
    }
  }
  if (b.cash != null) {
    const cash = Number(b.cash);
    if (cash >= 0) o.cashCollected = Math.round(cash);
  }
  save();
  return { ok: true, order: o };
};

api['GET /summary'] = (b, user) => {
  if (!user) return { error: 'Login required' };
  const total = db.orders.length;
  const delivered = db.orders.filter(o => o.status === 'delivered');
  const cashIn = delivered.reduce((s, o) => s + (o.cashCollected || 0), 0);
  const presold = db.orders.reduce((s, o) => s + o.total, 0);
  const byCoord = db.coordinators.filter(c => c.active).map(c => {
    const mine = db.orders.filter(o => o.takenBy === c.id);
    const mineDone = mine.filter(o => o.status === 'delivered');
    return {
      id: c.id,
      name: c.name,
      isAdmin: !!c.isAdmin,
      orders: mine.length,
      revenue: mine.reduce((s, o) => s + o.total, 0),
      delivered: mineDone.length,
      pending: mine.length - mineDone.length,
    };
  });
  const cashPerDeliverer = {};
  for (const o of delivered) {
    const k = o.deliveredByName || ('#' + o.deliveredBy);
    cashPerDeliverer[k] = (cashPerDeliverer[k] || 0) + (o.cashCollected || 0);
  }
  return {
    total, delivered: delivered.length, pending: total - delivered.length,
    presold, cashIn, cashExpected: cashIn, // updated as deliveries happen
    deliveredOutstanding: db.orders.filter(o => o.status === 'pending').reduce((s, o) => s + o.total, 0),
    byCoord,
    cashPerDeliverer,
    lastToken: db.counters.token,
  };
};

api['GET /export.csv'] = (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const rows = [['Token', 'Taken By', 'Customer', 'Phone', 'Place', 'Address', 'Items', 'Total', 'Status', 'Cash Collected', 'Delivered By', 'Delivered At', 'Created At']];
  for (const o of db.orders) {
    const c = o.customer || {};
    const itemsStr = (o.items || []).map(i => i.name + ' x' + i.qty).join(', ');
    rows.push([
      pad(o.tokenNo, 3), o.takenByName || '',
      c.name || '', c.phone || '', c.place || '', c.address || '',
      itemsStr,
      o.total, o.status, o.cashCollected == null ? '' : o.cashCollected,
      o.deliveredByName || '', o.deliveredAt || '', o.createdAt || '',
    ]);
  }
  return { csv: rows.map(r => r.map(csvEscape).join(',')).join('\r\n') };
};

api['POST /seed-demo'] = (b, user) => {
  if (db.coordinators.length || db.orders.length) return { error: 'Data already exists (nothing seeded)' };
  const mk = (name, pin, isAdmin) => ({ id: 888000 + db.coordinators.length, name, pin, isAdmin: !!isAdmin, active: true, createdAt: now() });
  db.coordinators.push(mk('admin', '1234', true));  for (const n of ['anil', 'sunil', 'babu']) db.coordinators.push(mk(n, '1111'));
  const menu = [
    ['Chicken Biriyani', 120], ['Mutton Biriyani', 180], ['Veg Biriyani', 100],
    ['Fried Rice', 90], ['Ghee Rice (Half)', 60], ['Lime Juice', 20],
  ];
  for (let i = 0; i < menu.length; i++) db.items.push({ id: 900 + i, name: menu[i][0], price: menu[i][1], order: i + 1, active: true });
  const itemsFor = (idxs) => idxs.map(([ii, q]) => ({ itemId: 900 + ii, name: db.items[ii].name, price: db.items[ii].price, qty: q }));
  const custs = [
    ['Ravi Kumar', '9847000001', 'Parish Hall Road', 'House 12, near fountain'],
    ['Mary Joseph', '9847000002', 'Church Street', '2nd floor'],
    ['Thomas Mathew', '9847000003', 'Collectorate Jn', ''],
  ];
  const demoOrders = [
    [1, custs[0], itemsFor([[0, 2], [5, 2]])],
    [2, custs[1], itemsFor([[1, 1], [3, 1]])],
    [0, custs[2], itemsFor([[2, 3]])],
    [2, null, itemsFor([[0, 1]])],
  ];
  for (let d = 0; d < demoOrders.length; d++) {
    const [takenIdx, cust, items] = demoOrders[d];
    const taker = db.coordinators[1 + (takenIdx % 3)];
    const total = items.reduce((s, it) => s + it.price * it.qty, 0);
    db.counters.order += 1;
    db.counters.token += 1;
    db.orders.push({
      id: db.counters.order, tokenNo: db.counters.token, takenBy: taker.id, takenByName: taker.name,
      customer: cust ? { name: cust[0], phone: cust[1], place: cust[2], address: cust[3] } : { name: 'Walk-in ' + (d + 1), phone: '', place: '', address: '' },
      items, total, status: 'pending', cashCollected: null, deliveredBy: null, deliveredByName: null, deliveredAt: null, createdAt: now(),
    });
    if (d < 2) { // some delivered for demo
      const o = db.orders[db.orders.length - 1];
      o.status = 'delivered'; o.cashCollected = o.total; o.deliveredBy = taker.id; o.deliveredByName = taker.name; o.deliveredAt = now();
    }
  }
  save();
  return { ok: true };
};

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
    const user = findCoordinatorByAuth(req);
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
