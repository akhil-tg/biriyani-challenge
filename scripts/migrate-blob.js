/* One-shot migration: app_state JSON blob -> normalized tables. Safe to re-run. */
'use strict';
const SUPA = 'https://acsauaywkyriukmpkjnt.supabase.co';
const KEY = process.env.SUPA_KEY;
const PAT = process.env.SUPA_PAT;
const REF = 'acsauaywkyriukmpkjnt';

const hdr = () => ({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' });

async function qb(path) {
  const r = await fetch(SUPA + path, { headers: hdr() });
  const t = await r.text();
  if (!r.ok) throw new Error('GET ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : [];
}
async function write(path, method, body, prefer) {
  const opt = { method, headers: hdr(prefer ? { Prefer: prefer } : undefined) };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(SUPA + path, opt);
  const t = await r.text();
  if (!r.ok) throw new Error(method + ' ' + r.status + ' ' + t.slice(0, 300));
  return t ? JSON.parse(t) : [];
}
async function runSql(sql) {
  const r = await fetch('https://api.supabase.com/v1/projects/' + REF + '/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('SQL ' + r.status + ' ' + t.slice(0, 300));
  return t ? JSON.parse(t) : [];
}

(async () => {
  // read the blob
  const rows = await qb('/rest/v1/app_state?id=eq.1&select=data');
  const db = rows[0] && rows[0].data;
  if (!db) throw new Error('No app_state blob found');
  console.log('blob:', (db.coordinators || []).length, 'coords,', (db.items || []).length, 'items,', (db.orders || []).length, 'orders');

  // skip anything already migrated (idempotent)
  const haveC = await qb('/rest/v1/coordinators?select=id');
  const haveI = await qb('/rest/v1/items?select=id');
  const haveO = await qb('/rest/v1/orders?select=id');
  const setA = a => new Set(a.map(r => Number(r.id)));
  const hasC = setA(haveC), hasI = setA(haveI), hasO = setA(haveO);

  for (const c of db.coordinators || []) {
    if (hasC.has(c.id)) continue;
    await write('/rest/v1/coordinators', 'POST', {
      id: c.id,
      auth_uid: c.authUid || null,
      name: c.name,
      email: c.email || null,
      is_admin: !!c.isAdmin,
      active: !!c.active,
      created_at: c.createdAt || new Date().toISOString(),
    }, 'return=minimal');
    console.log('coordinator', c.id, 'migrated');
  }
  for (const it of db.items || []) {
    if (hasI.has(it.id)) continue;
    await write('/rest/v1/items', 'POST', {
      id: it.id,
      name: it.name,
      price: it.price,
      sort: it.order != null ? it.order : it.id,
      active: !!it.active,
    }, 'return=minimal');
    console.log('item', it.id, 'migrated');
  }
  for (const o of db.orders || []) {
    if (hasO.has(o.id)) continue;
    const c = o.customer || {};
    await write('/rest/v1/orders', 'POST', {
      id: o.id,
      token_no: o.tokenNo || o.id,
      taken_by: o.takenBy || null,
      taken_by_name: o.takenByName || null,
      customer_name: c.name || '',
      customer_phone: c.phone || '',
      customer_place: c.place || '',
      customer_address: c.address || '',
      total: o.total || 0,
      status: o.status || 'pending',
      cash_collected: o.cashCollected != null ? o.cashCollected : null,
      delivered_by: o.deliveredBy || null,
      delivered_by_name: o.deliveredByName || null,
      delivered_at: o.deliveredAt || null,
      items: o.items || [],
      created_at: o.createdAt || new Date().toISOString(),
    }, 'return=minimal');
    console.log('order', o.id, 'migrated');
  }

  // push sequences past the max id so future inserts don't collide
  const res = await runSql([
    "select setval('coordinators_id_seq', coalesce((select max(id) from coordinators), 0));",
    "select setval('items_id_seq', coalesce((select max(id) from items), 0));",
    "select setval('orders_id_seq', coalesce((select max(id) from orders), 0));",
    "select setval('orders_token_seq', coalesce((select max(token_no) from orders), 0));",
  ].join('\n'));
  console.log('sequences set:', JSON.stringify(res));

  // final verify
  const [c, i, o] = await Promise.all([
    qb('/rest/v1/coordinators?select=id,name,is_admin,active'),
    qb('/rest/v1/items?select=id,name,price,sort,active'),
    qb('/rest/v1/orders?select=id,token_no,customer_name,total,status,cash_collected'),
  ]);
  console.log('VERIFY coordinators:', JSON.stringify(c));
  console.log('VERIFY items:', JSON.stringify(i));
  console.log('VERIFY orders:', JSON.stringify(o));
  console.log('MIGRATION COMPLETE');
})().catch(e => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
