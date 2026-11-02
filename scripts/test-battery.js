/* Live end-to-end test battery against the deployed worker (name + PIN auth).
 *
 * Requires an existing admin account on the deployment:
 *   BC_ADMIN_NAME / BC_ADMIN_PIN   (admin credentials)
 *   SUPA_URL / SUPA_KEY            (service key, for test-data cleanup)
 */
'use strict';
const B = 'https://biriyani-challenge.stgeorge.workers.dev';
const SUPA = (process.env.SUPA_URL || 'https://acsauaywkyriukmpkjnt.supabase.co').replace(/\/+$/, '');
const KEY = process.env.SUPA_KEY;
const ADMIN_NAME = process.env.BC_ADMIN_NAME;
const ADMIN_PIN = process.env.BC_ADMIN_PIN;

const suHdr = () => ({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' });

async function app(path, method, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(B + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); }
  return { status: r.status, body: j };
}
const ok = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  -> ' + extra : '')); if (!cond) process.exitCode = 1; };

if (!ADMIN_NAME || !ADMIN_PIN) { console.error('Set BC_ADMIN_NAME / BC_ADMIN_PIN first.'); process.exit(1); }

(async () => {
  const stamp = Date.now().toString(36);
  const coordName = 'battery-' + stamp;           // coordinator login
  const coordPin = String(100000 + Math.floor(Math.random() * 900000));

  // 1. status
  let r = await app('/api/status');
  ok('status setupLocked=false', r.body.setupLocked === false, JSON.stringify(r.body));
  ok('status needSetup=false (admin exists)', r.body.needSetup === false);

  // 2. admin login
  r = await app('/api/login', 'POST', { name: ADMIN_NAME, pin: ADMIN_PIN + '7' });
  ok('wrong PIN refused', !r.body.ok, r.body.error);
  r = await app('/api/login', 'POST', { name: ADMIN_NAME, pin: ADMIN_PIN });
  ok('admin login returns token', !!r.body.token, r.body.error);
  const admTok = r.body.token;
  ok('admin is flagged admin', r.body.user && r.body.user.isAdmin === true);
  ok('token has exp (30d)', /bc-v1\..+\..+/.test(admTok || ''));

  // 3. me → profile
  r = await app('/api/me', 'GET', null, admTok);
  ok('me returns admin profile', r.body.user && r.body.user.isAdmin, JSON.stringify(r.body.user));
  const admId = r.body.user && r.body.user.id;

  // 4. create a throwaway coordinator
  r = await app('/api/coordinators', 'POST', { name: coordName, pin: coordPin }, admTok);
  ok('coordinator created', r.body.ok && r.body.coordinator && !r.body.coordinator.isAdmin, JSON.stringify(r.body));
  const coord = r.body.coordinator;

  // 5. coordinator login + blocked-when-1digit
  r = await app('/api/login', 'POST', { name: coordName, pin: '12' });
  ok('short PIN refused', !r.body.ok, r.body.error);
  r = await app('/api/login', 'POST', { name: coordName, pin: coordPin });
  ok('coordinator login', !!r.body.token, r.body.error);
  const cTok = r.body.token;
  r = await app('/api/me', 'GET', null, cTok);
  ok('coordinator me (not admin)', r.body.user && !r.body.user.isAdmin, JSON.stringify(r.body.user));

  // 6. duplicate name refused / another admin can be created
  r = await app('/api/coordinators', 'POST', { name: coordName.toUpperCase(), pin: coordPin }, admTok);
  ok('duplicate name refused (case-insensitive)', !r.body.ok, r.body.error);

  // 7. items
  r = await app('/api/items', 'GET', null, cTok);
  ok('items list has active items', r.body.items && r.body.items.length > 0, JSON.stringify(r.body).slice(0, 120));
  const item = r.body.items.find(i => i.active);

  // 8. coordinator-only guard on items POST
  r = await app('/api/items', 'POST', { name: 'nope', price: 1 }, cTok);
  ok('coordinator cannot add items', !r.body.ok, r.body.error);

  // 9. create order
  r = await app('/api/orders', 'POST', {
    customer: { name: 'Battery Customer', phone: '9999999999', place: 'Testland', address: 'Nowhere St 42' },
    items: [{ itemId: item.id, qty: 2 }],
  }, cTok);
  ok('order created', r.body.ok && r.body.order, JSON.stringify(r.body).slice(0, 160));
  const ord = r.body.order;
  ok('token number assigned', ord && ord.tokenNo > 0, ord && ('token #' + ord.tokenNo));

  // 10. order shows in list
  r = await app('/api/orders', 'GET', null, cTok);
  ok('orders list contains new order', (r.body.orders || []).some(o => o.id === ord.id));

  // 11. deliver
  r = await app('/api/orders/' + ord.id + '/deliver', 'POST', {}, cTok);
  ok('order delivered', r.body.ok && r.body.order.status === 'delivered' && r.body.order.cashCollected === item.price * 2, JSON.stringify(r.body).slice(0, 160));

  // 12. double deliver refused
  r = await app('/api/orders/' + ord.id + '/deliver', 'POST', {}, cTok);
  ok('double deliver refused', !r.body.ok, r.body.error);

  // 13. summary
  r = await app('/api/summary', 'GET', null, cTok);
  ok('summary has totals', typeof r.body.total === 'number' && typeof r.body.cashIn === 'number', JSON.stringify(r.body).slice(0, 120));
  ok('summary lastToken >= new token', r.body.lastToken >= ord.tokenNo, r.body.lastToken);

  // 14. CSV blocked for coordinator
  r = await app('/api/export.csv', 'GET', null, cTok);
  ok('csv blocked for coordinator', !r.body.csv, r.body.error);
  r = await app('/api/export.csv', 'GET', null, admTok);
  ok('csv works for admin', /Token,/.test(r.body.csv || ''));

  // 15. admin can delete the battery order (keeps prod token sequence intact)
  r = await app('/api/orders/' + ord.id + '/update', 'POST', { delete: true }, admTok);
  ok('admin delete order', r.body.ok && r.body.deleted);

  // 16. legacy x-user spoofing must never grant access
  const sp = await fetch(B + '/api/me', { headers: { 'x-user': String(admId) } });
  const spBody = await sp.json().catch(() => ({}));
  ok('x-user spoofing blocked', !spBody.user, JSON.stringify(spBody));

  // 17. remove the coordinator -> their session dies immediately
  r = await app('/api/coordinators/remove', 'POST', { id: coord.id }, admTok);
  ok('coordinator removed', r.body.ok);
  r = await app('/api/me', 'GET', null, cTok);
  ok('removed coordinator token invalidated', !r.body.user, r.body.error);

  // -------- cleanup --------
  // remove the battery coordinator row and its order rows via the service key
  await fetch(SUPA + '/rest/v1/coordinators?id=eq.' + coord.id, { method: 'DELETE', headers: suHdr() });
  await fetch(SUPA + '/rest/v1/orders?id=eq.' + ord.id, { method: 'DELETE', headers: suHdr() });
  console.log('CLEANUP done — coordinator ' + coordName + ' and its orders removed');
})().catch(e => { console.error('BATTERY CRASHED:', e); process.exit(1); });
