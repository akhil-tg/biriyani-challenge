/* rest-api.js (ESM) — SQL-table storage + auth handlers (name + PIN model).
 *
 * Port of the repo-root rest-api.js for the Supabase Edge Function (Deno is
 * ESM-only). Handler logic is identical to the Cloudflare worker version:
 * same routes, same Supabase REST calls, same row mapping, same auth.
 *
 * Handlers live in `supabase/functions/_shared` so `api/index.ts` can import
 * them; the routing, CORS and rate-limiting glue is in `api/index.ts`.
 */
import * as auth from './auth.mjs';

let url = '';
let rootKey = '';
let authSecret = '';

function initSupa(env) {
  url = ((env && env.SUPABASE_URL) || '').replace(/\/+$/, '');
  rootKey = (env && env.SUPABASE_KEY) || '';
  authSecret = (env && env.AUTH_SECRET) || '';
  return !!(url && rootKey && authSecret);
}
function ready() { return !!(url && rootKey && authSecret); }

function hdr(extra) {
  return Object.assign({
    'apikey': rootKey,
    'Authorization': 'Bearer ' + rootKey,
    'Content-Type': 'application/json',
  }, extra || {});
}

async function qb(path) { // SELECT
  const res = await fetch(url + '/rest/v1/' + path, { headers: hdr() });
  const text = await res.text();
  if (!res.ok) throw new Error('DB query ' + res.status + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : [];
}

async function write(path, method, body, prefer) { // INSERT / PATCH / DELETE
  const opt = { method, headers: hdr(prefer ? { 'Prefer': prefer } : undefined) };
  if (body !== null && body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(url + '/rest/v1/' + path, opt);
  const text = await res.text();
  if (!res.ok) throw new Error('DB write ' + res.status + ': ' + text.slice(0, 300));
  let out = [];
  try { out = text && JSON.parse(text) || []; } catch { out = []; }
  return Array.isArray(out) ? out : [out];
}

async function selectOne(table, query) {
  const rows = await qb(table + '?' + query);
  return rows[0] || null;
}

/* ---- row <-> object mapping (frontend shape) ---- */
const now = () => new Date().toISOString();
const pad = (n, w) => String(n).padStart(w, '0');
const csvEscape = v => '"' + (v == null ? '' : String(v)).replace(/"/g, '""') + '"';

function coordRowToObj(r) {
  return {
    id: r.id,
    name: r.name,
    isAdmin: !!r.is_admin,
    active: !!r.active,
    createdAt: r.created_at,
  };
}
function itemRowToObj(r) {
  return { id: r.id, name: r.name, price: r.price, order: r.sort, sort: r.sort, active: !!r.active };
}
function orderRowToObj(r) {
  return {
    id: r.id,
    tokenNo: r.token_no,
    takenBy: r.taken_by,
    takenByName: r.taken_by_name,
    customer: {
      name: r.customer_name,
      phone: r.customer_phone || '',
      place: r.customer_place || '',
      address: r.customer_address || '',
    },
    items: Array.isArray(r.items) ? r.items : [],
    total: r.total,
    status: r.status,
    cashCollected: r.cash_collected,
    deliveredBy: r.delivered_by,
    deliveredByName: r.delivered_by_name,
    deliveredAt: r.delivered_at,
    createdAt: r.created_at,
  };
}

/* ---------- auth helpers ---------- */
function publicUser(row) {
  return row ? { id: row.id, name: row.name, isAdmin: !!row.is_admin, active: !!row.active } : null;
}

/* token -> user; also re-checks the account is still active. The active row
 * is cached briefly per isolate so repeated requests don't pay a DB hop
 * (the hop is expensive from the edge, ~0.6s); removed/deactivated accounts
 * therefore lose access within up to 30s instead of instantly. */
const USER_TTL_MS = 30000;
const userCache = new Map(); // token -> { user, at }

async function resolveUser(token) {
  if (!authSecret || !token) return null;
  const cached = userCache.get(token);
  if (cached && Date.now() - cached.at < USER_TTL_MS) return cached.user;
  const claims = await auth.verifySession(authSecret, token);
  if (!claims || typeof claims.id !== 'number') return null;
  const row = await selectOne('coordinators', 'id=eq.' + claims.id + '&active=eq.true&limit=1');
  if (!row) return null;
  const user = publicUser(row); // pass the raw DB row: publicUser reads is_admin/active
  if (userCache.size > 400) userCache.clear(); // crude prune
  userCache.set(token, { user, at: Date.now() });
  return user;
}

const nameQ = s => encodeURIComponent(String(s));

async function findAccountRow(name) {
  return qb('coordinators?name=ilike.' + nameQ(name) + '&active=eq.true');
}

function validatePin(pin) {
  return /^\d{6}$/.test(String(pin || '').trim());
}

async function issueSession(row) {
  const token = await auth.signSession(
    authSecret,
    { id: row.id, name: row.name, isAdmin: !!row.is_admin }
  );
  return {
    ok: true,
    token,
    user: publicUser(row), // pass the raw DB row: publicUser reads is_admin/active
  };
}

/* ---- pagination helper (orders can grow past the default limits) ---- */
async function allOrders() {
  let out = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const page = await qb('orders?order=id.desc&limit=1000&offset=' + offset);
    out = out.concat(page);
    if (page.length < 1000) break;
  }
  return out;
}

/* ---------------- handlers ---------------- */
const restApi = {};

restApi['GET /status'] = async () => {
  // three independent lookups: run in parallel (every page open hits this)
  const [admin, coord, ord] = await Promise.all([
    selectOne('coordinators', 'is_admin=eq.true&active=eq.true&limit=1'),
    selectOne('coordinators', 'limit=1'),
    selectOne('orders', 'limit=1').catch(() => null),
  ]);
  return {
    needSetup: !admin,
    hasData: !!coord || !!ord,
    setupLocked: false,
  };
};

/* first-run: create the first admin (name + 6-digit PIN) */
restApi['POST /setup'] = async b => {
  if (!authSecret) return { error: 'Server auth secret not configured' };
  const admin = await selectOne('coordinators', 'is_admin=eq.true&active=eq.true&limit=1');
  if (admin) return { error: 'Setup already done' };
  const name = (b.name || '').trim();
  const pin = String(b.pin || '').trim();
  if (!name || !validatePin(pin)) return { error: 'Name and 6-digit PIN required' };
  const dupes = await findAccountRow(name);
  if (dupes.length) return { error: 'Name already exists' };
  const rows = await write('coordinators', 'POST', [{
    name,
    pin_hash: await auth.newPinHash(pin),
    is_admin: true,
    active: true,
  }], 'return=representation');
  return issueSession(rows[0]);
};

restApi['POST /login'] = async b => {
  if (!authSecret) return { error: 'Server auth secret not configured' };
  const name = (b.name || '').trim();
  const pin = String(b.pin || '').trim();
  if (!name) return { error: 'Name required' };
  if (!validatePin(pin)) return { error: 'PIN must be 6 digits' };
  const rows = await findAccountRow(name);
  // admin first so a coordinator with the same (inactive) name can't shadow
  rows.sort((x, y) => (y.is_admin ? 1 : 0) - (x.is_admin ? 1 : 0));
  for (const row of rows) {
    if (await auth.checkPin(pin, row.pin_hash)) return issueSession(row);
  }
  return { ok: false, error: 'Wrong name or PIN' };
};

restApi['GET /me'] = (b, user) => (user ? { user } : { error: 'Login required' });

restApi['GET /coordinators'] = async (b, user) => {
  if (!user) return { error: 'Login required' };
  const rows = await qb('coordinators?active=eq.true&order=id.asc');
  return { coordinators: rows.map(coordRowToObj) };
};

restApi['POST /coordinators'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const name = (b.name || '').trim();
  const pin = String(b.pin || '').trim();
  if (!name) return { error: 'Name required' };
  if (!validatePin(pin)) return { error: 'PIN must be 6 digits' };
  const dupes = await findAccountRow(name);
  if (dupes.length) return { error: 'Name already exists' };
  const rows = await write('coordinators', 'POST', [{
    name,
    pin_hash: await auth.newPinHash(pin),
    is_admin: !!b.isAdmin,
    active: true,
  }], 'return=representation');
  return { ok: true, coordinator: coordRowToObj(rows[0]) };
};

restApi['POST /coordinators/remove'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const c = await selectOne('coordinators', 'id=eq.' + Number(b.id) + '&limit=1');
  if (c) await write('coordinators?id=eq.' + c.id, 'PATCH', { active: false }, 'return=minimal');
  return { ok: true };
};

restApi['GET /items'] = async () => ({ items: (await qb('items?active=eq.true&order=sort.asc')).map(itemRowToObj) });

restApi['POST /items'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const name = (b.name || '').trim();
  const price = Math.max(0, Number(b.price) || 0);
  if (!name) return { error: 'Name required' };
  const maxRow = await selectOne('items', 'order=sort.desc&limit=1&select=sort');
  const sort = (maxRow && maxRow.sort ? maxRow.sort : 0) + 1;
  const rows = await write('items', 'POST', [{ name, price, sort, active: true }], 'return=representation');
  return { ok: true, item: itemRowToObj(rows[0]) };
};

restApi['POST /items/update'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const patch = {};
  if (b.name != null) patch.name = String(b.name).trim();
  if (b.price != null) patch.price = Math.max(0, Number(b.price) || 0);
  if (!Object.keys(patch).length) return { error: 'Nothing to update' };
  const rows = await write('items?id=eq.' + Number(b.id), 'PATCH', patch, 'return=representation');
  if (!rows.length) return { error: 'Not found' };
  return { ok: true, item: itemRowToObj(rows[0]) };
};

restApi['POST /items/remove'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  await write('items?id=eq.' + Number(b.id), 'PATCH', { active: false }, 'return=minimal');
  return { ok: true };
};

restApi['POST /orders'] = async (b, user) => {
  if (!user) return { error: 'Login required' };
  const cust = b.customer || {};
  const requested = Array.isArray(b.items) ? b.items.filter(i => i.qty > 0) : [];
  if (!requested.length) return { error: 'Add at least one item' };
  const custName = (cust.name || '').trim();
  if (!custName) return { error: 'Customer name required' };

  /* request_key (unique in DB) makes replays safe: we INSERT blindly —
   * if the same key was already stored, Postgres rejects the duplicate
   * (409) and we return the stored order. No pre-check round-trip needed. */
  const rk = String(b.request_key || '').slice(0, 80).trim() || null;
  const ids = [...new Set(requested.map(r => Number(r.itemId)))].filter(Number.isFinite);
  const menu = ids.length ? await qb('items?id=in.(' + ids.join(',') + ')&active=eq.true') : [];
  const byId = new Map(menu.map(m => [m.id, m]));
  const snapshot = [];
  let total = 0;
  for (const r of requested) {
    const m = byId.get(Number(r.itemId));
    if (!m) return { error: 'Unknown item' };
    const qty = Math.max(1, Math.floor(Number(r.qty) || 0));
    snapshot.push({ itemId: m.id, name: m.name, price: m.price, qty });
    total += m.price * qty;
  }

  const insert = [{
    taken_by: user.id,
    taken_by_name: user.name,
    customer_name: custName,
    customer_phone: (cust.phone || '').trim(),
    customer_place: (cust.place || '').trim(),
    customer_address: (cust.address || '').trim(),
    total,
    status: 'pending',
    items: snapshot,
    request_key: rk,
  }];
  let rows;
  try {
    rows = await write('orders', 'POST', insert, 'return=representation');
  } catch (e) {
    if (rk && /409|duplicate/i.test(String((e && e.message) || ''))) {
      // lost a race with another gateway executing the same request_key
      const dup = await selectOne('orders', 'request_key=eq.' + encodeURIComponent(rk) + '&limit=1');
      if (dup) return { ok: true, order: orderRowToObj(dup), already: true };
    }
    throw e;
  }
  return { ok: true, order: orderRowToObj(rows[0]) };
};

restApi['GET /orders'] = async (b, user, url) => {
  if (!user) return { error: 'Login required' };
  const status = url ? url.searchParams.get('status') : null;
  let path = 'orders?order=id.desc&limit=500';
  if (status === 'pending' || status === 'delivered') path += '&status=eq.' + status;
  // both lookups are independent: run in parallel to save a round-trip
  const [orders, coordinators] = await Promise.all([
    qb(path),
    qb('coordinators?active=eq.true&order=id.asc'),
  ]);
  return { orders: orders.map(orderRowToObj), coordinators: coordinators.map(coordRowToObj) };
};

restApi['GET /orders/:id'] = async (b, user, url, id) => {
  if (!user) return { error: 'Login required' };
  const r = await selectOne('orders', 'id=eq.' + id + '&limit=1');
  return r ? { order: orderRowToObj(r) } : { error: 'Order not found' };
};

restApi['POST /orders/:id/deliver'] = async (b, user, url, id) => {
  if (!user) return { error: 'Login required' };
  const hasCash = !(b.cash == null || b.cash === '');
  const cash = hasCash ? Number(b.cash) : null;

  // fast path: the client (deliver page) already sends the cash amount, so we
  // can go straight to the conditional PATCH (1 DB round-trip instead of 2)
  if (hasCash && !(cash >= 0)) return { error: 'Invalid cash amount' };
  if (hasCash) {
    const rows = await write('orders?id=eq.' + id + '&status=eq.pending', 'PATCH', {
      status: 'delivered',
      cash_collected: Math.round(cash),
      delivered_by: user.id,
      delivered_by_name: user.name,
      delivered_at: now(),
    }, 'return=representation');
    if (rows && rows.length) return { ok: true, order: orderRowToObj(rows[0]) };
    const cur = await selectOne('orders', 'id=eq.' + id + '&limit=1');
    if (!cur) return { error: 'Order not found' };
    if (cur.status === 'delivered') return { error: 'Already delivered' };
    return { error: 'Order was already delivered or updated by another coordinator' };
  }

  // fallback (e.g. admin marks delivered without a cash figure): default cash
  // to the order total, which needs the current row first
  const cur = await selectOne('orders', 'id=eq.' + id + '&limit=1');
  if (!cur) return { error: 'Order not found' };
  if (cur.status === 'delivered') return { error: 'Already delivered' };
  const rows = await write('orders?id=eq.' + id + '&status=eq.pending', 'PATCH', {
    status: 'delivered',
    cash_collected: Math.round(cur.total),
    delivered_by: user.id,
    delivered_by_name: user.name,
    delivered_at: now(),
  }, 'return=representation');
  if (!rows || !rows.length) return { error: 'Order was already delivered or updated by another coordinator' };
  return { ok: true, order: orderRowToObj(rows[0]) };
};

restApi['POST /orders/:id/update'] = async (b, user, url, id) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const cur = await selectOne('orders', 'id=eq.' + id + '&limit=1');
  if (!cur) return { error: 'Order not found' };

  if (b.delete) {
    await write('orders?id=eq.' + id, 'DELETE', null, 'return=minimal');
    return { ok: true, deleted: true };
  }

  const patch = {};
  if (cur.status === 'pending') {
    if (b.customer) {
      const c = b.customer;
      if (c.name != null) patch.customer_name = String(c.name).trim();
      if (c.phone != null) patch.customer_phone = String(c.phone).trim();
      if (c.place != null) patch.customer_place = String(c.place).trim();
      if (c.address != null) patch.customer_address = String(c.address).trim();
    }
    if (b.items) {
      const ids = [...new Set(b.items.map(x => Number(x.itemId)))].filter(Number.isFinite);
      const menu = ids.length ? await qb('items?id=in.(' + ids.join(',') + ')&active=eq.true') : [];
      const byId = new Map(menu.map(m => [m.id, m]));
      const snapshot = [];
      for (const it of b.items) {
        const m = byId.get(Number(it.itemId));
        const qty = Math.max(1, Math.floor(Number(it.qty) || 0));
        if (m && qty > 0) snapshot.push({ itemId: m.id, name: m.name, price: m.price, qty });
      }
      if (snapshot.length) {
        patch.items = snapshot;
        patch.total = snapshot.reduce((s, i) => s + i.price * i.qty, 0);
      }
    }
  }
  if (b.cash != null) {
    const cash = Number(b.cash);
    if (cash >= 0) patch.cash_collected = Math.round(cash);
  }
  if (Object.keys(patch).length) {
    const rows = await write('orders?id=eq.' + id, 'PATCH', patch, 'return=representation');
    return { ok: true, order: orderRowToObj(rows[0]) };
  }
  return { ok: true, order: orderRowToObj(cur) };
};

restApi['GET /summary'] = async (b, user) => {
  if (!user) return { error: 'Login required' };
  const [rows, coordsRaw] = await Promise.all([
    allOrders(),
    qb('coordinators?active=eq.true&order=id.asc'),
  ]);
  const orders = rows.map(orderRowToObj);
  const coords = coordsRaw.map(coordRowToObj);

  const total = orders.length;
  const delivered = orders.filter(o => o.status === 'delivered');
  const cashIn = delivered.reduce((s, o) => s + (o.cashCollected || 0), 0);
  const presold = orders.reduce((s, o) => s + (o.total || 0), 0);
  const byCoord = coords.map(c => {
    const mine = orders.filter(o => o.takenBy === c.id);
    const mineDone = mine.filter(o => o.status === 'delivered');
    return {
      id: c.id, name: c.name, isAdmin: !!c.isAdmin,
      orders: mine.length,
      revenue: mine.reduce((s, o) => s + (o.total || 0), 0),
      delivered: mineDone.length,
      pending: mine.length - mineDone.length,
    };
  });
  const cashPerDeliverer = {};
  for (const o of delivered) {
    const k = o.deliveredByName || ('#' + o.deliveredBy);
    cashPerDeliverer[k] = (cashPerDeliverer[k] || 0) + (o.cashCollected || 0);
  }
  const lastToken = rows.reduce((m, r) => Math.max(m, r.token_no || 0), 0);
  return {
    total, delivered: delivered.length, pending: total - delivered.length,
    presold, cashIn, cashExpected: cashIn,
    deliveredOutstanding: orders.filter(o => o.status === 'pending').reduce((s, o) => s + (o.total || 0), 0),
    byCoord, cashPerDeliverer, lastToken,
  };
};

restApi['GET /export.csv'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const rows = [['Token', 'Taken By', 'Customer', 'Phone', 'Place', 'Address', 'Items', 'Total', 'Status', 'Cash Collected', 'Delivered By', 'Delivered At', 'Created At']];
  const all = (await allOrders()).map(orderRowToObj);
  for (const o of all.sort((a, bb) => a.tokenNo - bb.tokenNo)) {
    const c = o.customer || {};
    rows.push([
      pad(o.tokenNo, 3), o.takenByName || '',
      c.name || '', c.phone || '', c.place || '', c.address || '',
      (o.items || []).map(i => i.name + ' x' + i.qty).join(', '),
      o.total, o.status, o.cashCollected == null ? '' : o.cashCollected,
      o.deliveredByName || '', o.deliveredAt || '', o.createdAt || '',
    ]);
  }
  return { csv: rows.map(r => r.map(csvEscape).join(',')).join('\r\n') };
};

export { initSupa, ready, restApi, resolveUser };
