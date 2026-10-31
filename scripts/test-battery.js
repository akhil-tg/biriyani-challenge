/* Live end-to-end test battery against the deployed REST-backed Worker. */
'use strict';
const B = 'https://biriyani-challenge.stgeorge.workers.dev';
const SUPA = 'https://acsauaywkyriukmpkjnt.supabase.co';
const KEY = process.env.SUPA_KEY;

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

(async () => {
  const stamp = Date.now();
  const email = 'test-battery-' + stamp + '@delete-me.test';
  const pass = 'battery-' + stamp + 'xQ';

  // 1. status
  let r = await app('/api/status');
  ok('status setupLocked', r.body.setupLocked === true && r.body.needSetup === false, JSON.stringify(r.body));

  // 2. create throwaway auth user (admin API)
  let cr = await fetch(SUPA + '/auth/v1/admin/users', { method: 'POST', headers: suHdr(), body: JSON.stringify({ email, password: pass, email_confirm: true, user_metadata: { name: 'battery-tester' } }) });
  const created = await cr.json().catch(() => ({}));
  ok('auth user created', cr.ok, created.email || cr.status);

  // 3. login through the app
  r = await app('/api/auth/login', 'POST', { email, password: pass });
  const tok = r.body.access_token;
  ok('auth/login returns token', !!tok);
  ok('auth/login noanon-refresh', !!r.body.refresh_token);

  // 4. /me auto-provision (should be coordinator, NOT admin — admin exists)
  r = await app('/api/me', 'GET', null, tok);
  ok('me provisioned', !!r.body.user, r.body.user && r.body.user.name);
  ok('not admin (first admin already claimed)', r.body.user && r.body.user.isAdmin === false);
  const uid = r.body.user && r.body.user.id;

  // 5. items
  r = await app('/api/items', 'GET', null, tok);
  ok('items list has active Biriyani', r.body.items && r.body.items.some(i => i.name === 'Biriyani' && i.price === 150), JSON.stringify(r.body));
  const item = r.body.items.find(i => i.active);

  // 6. coordinator-only guard on items POST (mongo-free check of admin guard)
  r = await app('/api/items', 'POST', { name: 'nope', price: 1 }, tok);
  ok('coordinator cannot add items', !r.body.ok, r.body.error);

  // 7. create order
  r = await app('/api/orders', 'POST', {
    customer: { name: 'Battery Customer', phone: '9999999999', place: 'Testland', address: 'Nowhere St 42' },
    items: [{ itemId: item.id, qty: 2 }],
  }, tok);
  ok('order created', r.body.ok && r.body.order && r.body.order.total === 300, r.body.order && ('token #' + r.body.order.tokenNo));
  const ord = r.body.order;

  // 8. order shows in list
  r = await app('/api/orders', 'GET', null, tok);
  ok('orders list contains new order', (r.body.orders || []).some(o => o.id === ord.id));
  ok('orders list contains legacy real order', (r.body.orders || []).some(o => o.tokenNo === 1));

  // 9. deliver
  r = await app('/api/orders/' + ord.id + '/deliver', 'POST', {}, tok);
  ok('order delivered', r.body.ok && r.body.order.status === 'delivered' && r.body.order.cashCollected === 300, JSON.stringify(r.body.order && r.body.order.status));

  // 10. double deliver guard
  r = await app('/api/orders/' + ord.id + '/deliver', 'POST', {}, tok);
  ok('double deliver refused', !r.body.ok, r.body.error);

  // 11. summary
  r = await app('/api/summary', 'GET', null, tok);
  ok('summary totals', r.body.total === 2 && r.body.delivered === 2 && r.body.cashIn === 450, JSON.stringify(r.body));
  ok('summary lastToken >=', r.body.lastToken >= 2, r.body.lastToken);

  // 12. CSV (admin only)
  r = await app('/api/export.csv', 'GET', null, tok);
  ok('csv blocked for coordinator', !r.body.csv, r.body.error);

  // 13. token monotonicity: create+delete shouldn't regress sequence
  r = await app('/api/orders', 'POST', {
    customer: { name: 'Delete Me' }, items: [{ itemId: item.id, qty: 1 }],
  }, tok);
  const delOrder = r.body.order;
  r = await app('/api/orders/' + delOrder.id + '/update', 'POST', { delete: true }, tok);
  ok('admin delete blocked for coordinator', !r.body.ok, r.body.error);

  // 14. legacy x-user spoofing on locked deployment
  const sp = await fetch(B + '/api/me', { headers: { 'x-user': '1' } });
  const spBody = await sp.json().catch(() => ({}));
  ok('x-user spoofing blocked', !spBody.user, JSON.stringify(spBody));

  // 15. bad password login
  r = await app('/api/auth/login', 'POST', { email, password: 'wrong-password' });
  ok('bad password refused', !r.body.access_token, r.body.error);

  // -------- cleanup --------
  // delete battery order rows (the deliver one) directly via service key
  await fetch(SUPA + '/rest/v1/orders?id=eq.' + ord.id, { method: 'DELETE', headers: suHdr() });
  // remove provisioned coordinator row
  if (uid) await fetch(SUPA + '/rest/v1/coordinators?id=eq.' + uid, { method: 'DELETE', headers: suHdr() });
  // remove throwaway auth user
  await fetch(SUPA + '/auth/v1/admin/users/' + created.id, { method: 'DELETE', headers: suHdr() });
  // final verify: only the real admin + original order remain
  const fc = await (await fetch(SUPA + '/rest/v1/coordinators?select=id,name', { headers: suHdr() })).json();
  const fo = await (await fetch(SUPA + '/rest/v1/orders?select=id,token_no,customer_name', { headers: suHdr() })).json();
  console.log('AFTER CLEANUP coordinators:', JSON.stringify(fc), ' orders:', JSON.stringify(fo));
  ok('cleanup: only real admin remains', fc.length === 1 && fc[0].name === 'akhiltg3d21');
  ok('cleanup: only real order remains', fo.length === 1 && fo[0].token_no === 1);
})().catch(e => { console.error('BATTERY CRASHED:', e); process.exit(1); });
