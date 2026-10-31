/* shared-api.js — API handlers + data model, shared by:
 *  - server.js  (Node http server; Supabase or file storage)
 *  - worker.js  (Cloudflare Workers; Supabase storage per request)
 *
 * Handlers mutate the in-memory `db` in place and call save() when done.
 * The storage layer decides what save() does.
 */
'use strict';

const defaultCounters = () => ({ order: 0, token: 0 });

let db = { coordinators: [], items: [], orders: [], counters: { order: 0, token: 0 } };
let save = () => {};
let setupLocked = false;

function setSave(fn) { save = fn; }
// When true, POST /setup and POST /seed-demo refuse web-based admin creation —
// the admin is provisioned via Supabase Authentication instead.
function setSetupLocked(v) { setupLocked = !!v; }

/* ---- Supabase environment (set by each host: worker env vars / process.env) ---- */
let ENV = {};
function setEnv(e) { ENV = e || {}; }

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

/* Find (or auto-create) the coordinator profile that belongs to this
 * authenticated user. The FIRST profile ever provisioned on the deployment
 * automatically becomes the Admin — that is how dashboard-created accounts
 * are claimed. */
function coordinatorForAuthUser(userId, email, name) {
  let c = db.coordinators.find(x => x.authUid === userId);
  if (c) return c.active ? c : null; // disabled profiles cannot log in
  const anyAdmin = db.coordinators.some(x => x.active && x.isAdmin);
  const maxCoordId = db.coordinators.reduce((mm, x) => Math.max(mm, x.id || 0), 0);
  c = {
    id: maxCoordId + 1,
    name: name || (email || 'user').split('@')[0],
    email: email || '',
    authUid: userId,
    isAdmin: !anyAdmin,
    active: true,
    createdAt: now(),
  };
  db.coordinators.push(c);
  save();
  return c;
}

const restDb = require('./rest-api.js');

/* Who is making this request?
 *   Supabase deployments (setupLocked): Authorization: Bearer <auth JWT> only
 *   file deployments:                   legacy X-User id from the PIN login */
async function resolveUser(request) {
  const h = request.headers || {};
  if (ENV.SUPABASE_URL && ENV.SUPABASE_KEY) {
    const au = await resolveAuthUser(h);
    if (au) {
      if (setupLocked) {
        if (!restDb.ready()) restDb.initSupa(ENV);
        return await restDb.resolveCoordinator(au);
      }
      return coordinatorForAuthUser(au.id, au.email, au.name);
    }
    if (setupLocked) return null; // locked deployments don't trust the legacy header
  }
  return findCoordinatorByAuth(request);
}

/* Replace db contents in place so existing references stay valid. */
function hydrate(data) {
  data = data && typeof data === 'object' ? data : {};
  db.coordinators = Array.isArray(data.coordinators) ? data.coordinators : [];
  db.items = Array.isArray(data.items) ? data.items : [];
  db.orders = Array.isArray(data.orders) ? data.orders : [];
  const c = data.counters && typeof data.counters === 'object' ? data.counters : {};
  db.counters = {
    order: typeof c.order === 'number' ? c.order : 0,
    token: typeof c.token === 'number' ? c.token : 0,
  };
  return db;
}

const now = () => new Date().toISOString();
const pad = (n, w) => String(n).padStart(w, '0');

function publicUser(c) {
  return c ? { id: c.id, name: c.name, email: c.email || undefined, isAdmin: !!c.isAdmin, active: !!c.active } : null;
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
  setupLocked: setupLocked,
});

// first-run: create the first admin (only allowed while no admin exists)
api['POST /setup'] = b => {
  if (setupLocked) return { error: 'Admin creation is locked on this deployment — provision the admin directly in Supabase.' };
  if (db.coordinators.some(c => c.active && c.isAdmin)) return { error: 'Setup already done' };
  const name = (b.name || '').trim();
  const pin = (b.pin || '').trim();
  if (!name || !/^\d{4}$/.test(pin)) return { error: 'Name and 4-digit PIN required' };
  const c = { id: 1, name, pin, isAdmin: true, active: true, createdAt: now() };
  db.coordinators.push(c); save();
  return { ok: true, user: publicUser(c) };
};

api['POST /login'] = b => {
  if (setupLocked && ENV.SUPABASE_URL) {
    return { error: 'This deployment uses email + password login (Supabase Authentication).' };
  }
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

api['POST /coordinators'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const name = (b.name || '').trim();
  if (!name) return { error: 'Name required' };
  if (db.coordinators.some(c => c.active && c.name.toLowerCase() === name.toLowerCase()))
    return { error: 'Name already exists' };
  const maxCoordId = db.coordinators.reduce((m, x) => Math.max(m, x.id || 0), 0);

  /* Supabase deployment: create a real auth account (email + password) */
  if (setupLocked && ENV.SUPABASE_URL && ENV.SUPABASE_KEY) {
    const email = (b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!/.+@.+\..+/.test(email)) return { error: 'Valid email required' };
    if (password.length < 6) return { error: 'Password must be at least 6 characters' };
    const res = await fetch((ENV.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/admin/users', {
      method: 'POST',
      headers: supaHeaders(),
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: (body && (body.msg || body.message || body.error_description)) || ('Supabase auth error ' + res.status) };
    const uid = body.id;
    let c = db.coordinators.find(x => x.authUid === uid);
    if (c) { c.name = name; c.active = true; }
    else {
      c = { id: maxCoordId + 1, name, email, authUid: uid, isAdmin: !!b.isAdmin, active: true, createdAt: now() };
      db.coordinators.push(c);
    }
    save();
    return { ok: true, coordinator: publicUser(c) };
  }

  /* legacy file deployment: PIN-based coordinator */
  const pin = (b.pin || '').trim();
  if (!pin) return { error: 'PIN required' };
  const c = { id: maxCoordId + 1, name, pin, isAdmin: !!b.isAdmin, active: true, createdAt: now() };
  db.coordinators.push(c); save();
  return { ok: true, coordinator: publicUser(c) };
};

api['POST /coordinators/remove'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const c = db.coordinators.find(x => x.id === b.id);
  if (c) {
    // Supabase deployment: delete their auth account too, so they can't log in
    if (c.authUid && ENV.SUPABASE_URL && ENV.SUPABASE_KEY) {
      try {
        await fetch((ENV.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/admin/users/' + c.authUid, {
          method: 'DELETE',
          headers: supaHeaders(),
        });
      } catch (e) { /* deproceed with the profile removal regardless */ }
    }
    c.active = false; save();
  }
  return { ok: true };
};

/* current authenticated session -> profile (also triggers auto-provisioning) */
api['GET /me'] = (b, user) => (user ? { user: publicUser(user) } : { error: 'Login required' });

/* Supabase auth passthrough (so the public frontend never needs an anon key) */
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
  let list = db.orders.slice(); // newest-first? will sort
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
  if (setupLocked) return { error: 'Demo data is disabled on this deployment.' };
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

module.exports = {
  api, restApi: restDb.restApi, setSave, setSetupLocked, setEnv, hydrate, getDb: () => db,
  countersEmpty: defaultCounters, findCoordinatorByAuth, resolveUser,
  initRest: () => { if (ENV.SUPABASE_URL && ENV.SUPABASE_KEY && !restDb.ready()) restDb.initSupa(ENV); },
};
