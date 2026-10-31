/* rest-api.js — SQL-table storage handlers for locked (Supabase) deployments.
 *
 * Every handler talks directly to Postgres tables via the Supabase REST API
 * (PostgREST). Rows and columns are what you see in the Supabase Table Editor:
 *   coordinators(id, auth_uid, name, email, is_admin, active, created_at)
 *   items(id, name, price, sort, active)
 *   orders(id, token_no, taken_by.., customer_*, total, status, cash,
 *          delivered_*, items jsonb, created_at)
 *
 * The public response shapes are identical to shared-api.js, so frontend and
 * host stay unchanged — only persistence is normalized.
 */
'use strict';

let url = '';
let rootKey = '';

function initSupa(env) {
  url = ((env && env.SUPABASE_URL) || '').replace(/\/+$/, '');
  rootKey = (env && env.SUPABASE_KEY) || '';
  return !!(url && rootKey);
}
function ready() { return !!(url && rootKey); }

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
  return { id: r.id, authUid: r.auth_uid, name: r.name, email: r.email || undefined, isAdmin: !!r.is_admin, active: !!r.active, createdAt: r.created_at };
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
function orderObjToRow(o, user) {
  const c = o.customer || {};
  return {
    taken_by: user ? user.id : (o.takenBy || null),
    taken_by_name: user ? user.name : (o.takenByName || null),
    customer_name: c.name || '',
    customer_phone: c.phone || '',
    customer_place: c.place || '',
    customer_address: c.address || '',
    total: Math.max(0, Math.round(Number(o.total) || 0)),
    status: o.status || 'pending',
    items: o.items || [],
  };
}

/* auth profile provisioning — unique auth_uid + read-back means races are safe */
async function resolveCoordinator(au) {
  let row = await selectOne('coordinators', 'auth_uid=eq.' + au.id + '&limit=1');
  if (row) return row.active ? coordRowToObj(row) : null;
  const anyAdminRow = await selectOne('coordinators', 'is_admin=eq.true&active=eq.true',);
  await write('coordinators', 'POST', [{
    auth_uid: au.id,
    name: au.name || (au.email || 'user').split('@')[0],
    email: au.email,
    is_admin: !anyAdminRow, // the first provisioned profile becomes the Admin
    active: true,
  }], 'return=representation,resolution=merge-duplicates');
  // read back the authoritative row (in case a concurrent upsert won)
  row = await selectOne('coordinators', 'auth_uid=eq.' + au.id + '&limit=1');
  return row && row.active ? coordRowToObj(row) : null;
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
  const admin = await selectOne('coordinators', 'is_admin=eq.true&active=eq.true&limit=1');
  const coord = await selectOne('coordinators', 'limit=1');
  let ord = null;
  try { ord = await selectOne('orders', 'limit=1'); } catch {}
  return { needSetup: !admin, hasData: !!coord || !!ord, setupLocked: true };
};

restApi['POST /setup'] = async () => ({ error: 'Admin creation is locked — create the admin in Supabase Authentication.' });
restApi['POST /seed-demo'] = async () => ({ error: 'Demo data is disabled on this deployment.' });
restApi['POST /login'] = async () => ({ error: 'This deployment uses email + password login (Supabase Authentication).' });

restApi['GET /me'] = (b, user) => {
  if (!user) return { error: 'Login required' };
  return { user: { id: user.id, name: user.name, email: user.email, isAdmin: !!user.isAdmin, active: !!user.active } };
};

restApi['GET /coordinators'] = async (b, user) => {
  if (!user) return { error: 'Login required' };
  const rows = await qb('coordinators?active=eq.true&order=id.asc');
  return { coordinators: rows.map(coordRowToObj) };
};

restApi['POST /coordinators'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const name = (b.name || '').trim();
  if (!name) return { error: 'Name required' };
  const dupe = await selectOne('coordinators', 'active=eq.true&name=ilike.' + encodeURIComponent(name) + '&limit=1');
  if (dupe) return { error: 'Name already exists' };
  const email = (b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!/.+@.+\..+/.test(email)) return { error: 'Valid email required' };
  if (password.length < 6) return { error: 'Password must be at least 6 characters' };
  const res = await fetch(url + '/auth/v1/admin/users', {
    method: 'POST',
    headers: hdr(),
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } }),
  });
  const body2 = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (body2 && (body2.msg || body2.message || body2.error_description)) || ('Supabase auth error ' + res.status) };
  const rows = await write('coordinators', 'POST', [{
    auth_uid: body2.id, name, email, is_admin: !!b.isAdmin, active: true,
  }], 'return=representation');
  return { ok: true, coordinator: coordRowToObj(rows[0]) };
};

restApi['POST /coordinators/remove'] = async (b, user) => {
  if (!user || !user.isAdmin) return { error: 'Admin only' };
  const c = await selectOne('coordinators', 'id=eq.' + Number(b.id) + '&limit=1');
  if (c) {
    if (c.auth_uid) {
      try { await fetch(url + '/auth/v1/admin/users/' + c.auth_uid, { method: 'DELETE', headers: hdr() }); } catch {}
    }
    await write('coordinators?id=eq.' + c.id, 'PATCH', { active: false, is_admin: false }, 'return=minimal');
  }
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

  const rows = await write('orders', 'POST', [{
    taken_by: user.id,
    taken_by_name: user.name,
    customer_name: custName,
    customer_phone: (cust.phone || '').trim(),
    customer_place: (cust.place || '').trim(),
    customer_address: (cust.address || '').trim(),
    total,
    status: 'pending',
    items: snapshot,
  }], 'return=representation');
  return { ok: true, order: orderRowToObj(rows[0]) };
};

restApi['GET /orders'] = async (b, user, url) => {
  if (!user) return { error: 'Login required' };
  const status = url ? url.searchParams.get('status') : null;
  let path = 'orders?order=id.desc&limit=500';
  if (status === 'pending' || status === 'delivered') path += '&status=eq.' + status;
  const orders = (await qb(path)).map(orderRowToObj);
  const coordinators = (await qb('coordinators?active=eq.true&order=id.asc')).map(coordRowToObj);
  return { orders, coordinators };
};

restApi['GET /orders/:id'] = async (b, user, url, id) => {
  if (!user) return { error: 'Login required' };
  const r = await selectOne('orders', 'id=eq.' + id + '&limit=1');
  return r ? { order: orderRowToObj(r) } : { error: 'Order not found' };
};

restApi['POST /orders/:id/deliver'] = async (b, user, url, id) => {
  if (!user) return { error: 'Login required' };
  const cur = await selectOne('orders', 'id=eq.' + id + '&limit=1');
  if (!cur) return { error: 'Order not found' };
  if (cur.status === 'delivered') return { error: 'Already delivered' };
  let cash = b.cash == null || b.cash === '' ? cur.total : Number(b.cash);
  if (!(cash >= 0)) cash = cur.total;
  const rows = await write('orders?id=eq.' + id, 'PATCH', {
    status: 'delivered',
    cash_collected: Math.round(cash),
    delivered_by: user.id,
    delivered_by_name: user.name,
    delivered_at: now(),
  }, 'return=representation');
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
  const rows = await allOrders();
  const orders = rows.map(orderRowToObj);
  const coords = (await qb('coordinators?active=eq.true&order=id.asc')).map(coordRowToObj);

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

module.exports = { initSupa, ready, restApi, resolveCoordinator };
