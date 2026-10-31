/* shared helpers */
const $ = sel => document.querySelector(sel);
const money = n => '₹' + (Number(n) || 0).toLocaleString('en-IN');
const padTok = n => String(n).padStart(3, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, body, method) {
  const tok = localStorage.getItem('bc_tok');
  const make = t => {
    const opt = {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' },
    };
    if (t) opt.headers['Authorization'] = 'Bearer ' + t;
    else opt.headers['X-User'] = localStorage.getItem('bc_uid') || '';
    if (body !== undefined) opt.body = JSON.stringify(body);
    return opt;
  };
  let res = await fetch('/api/' + path, make(tok));
  let out = {};
  try { out = await res.json(); } catch {}
  if (out && out.error === 'Login required') {
    // Supabase mode: session may have expired — refresh once and retry
    if (tok && localStorage.getItem('bc_rt')) {
      const rr = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: localStorage.getItem('bc_rt') }),
      });
      const rj = await rr.json().catch(() => ({}));
      if (rj && rj.access_token) {
        localStorage.setItem('bc_tok', rj.access_token);
        if (rj.refresh_token) localStorage.setItem('bc_rt', rj.refresh_token);
        res = await fetch('/api/' + path, make(rj.access_token));
        out = {};
        try { out = await res.json(); } catch {}
        if (!(out && out.error)) return out;
      }
    }
    logout(true);
  }
  return out;
}

function logout(quiet) {
  if (!quiet && !confirm('Log out?')) return;
  localStorage.removeItem('bc_uid');
  localStorage.removeItem('bc_user');
  localStorage.removeItem('bc_tok');
  localStorage.removeItem('bc_rt');
  location.href = '/index.html';
}

function getUser() {
  try { return JSON.parse(localStorage.getItem('bc_user') || 'null'); } catch { return null; }
}

function requireLogin(isAdminPage) {
  const u = getUser();
  if (!u) { location.href = '/index.html'; return null; }
  if (isAdminPage && !u.isAdmin) { location.href = '/order.html'; return null; }
  return u;
}

function toast(msg, ms) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms || 2600);
}

function topbar(user, title) {
  const roleBadge = user && user.isAdmin ? '<span class="badge" style="background:var(--saffron);color:#fff;margin-left:4px;font-size:10.5px">ADMIN</span>' : '';
  return `<div class="topbar">
    <h1 style="flex:1">${esc(title)}</h1>
    <span class="who">${esc(user.name)}${roleBadge}</span>
    <button class="logout" onclick="logout()">Logout</button>
  </div>`;
}

function coordNav(active) {
  const u = getUser();
  const adminLink = (u && u.isAdmin)
    ? `<a href="/admin.html" class="${active === 'admin' ? 'on' : ''}"><span>⚙️</span>Admin</a>`
    : '';
  return `<nav class="bottomnav">
    <a href="/order.html" class="${active === 'order' ? 'on' : ''}"><span>📝</span>Order</a>
    <a href="/orders.html" class="${active === 'orders' ? 'on' : ''}"><span>🌍</span>All</a>
    <a href="/deliver.html" class="${active === 'deliver' ? 'on' : ''}"><span>🥘</span>Deliver</a>
    ${adminLink}
  </nav>`;
}
