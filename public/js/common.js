/* shared helpers */
const $ = sel => document.querySelector(sel);
const money = n => '₹' + (Number(n) || 0).toLocaleString('en-IN');
const padTok = n => String(n).padStart(3, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, body, method) {
  const opt = {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-User': localStorage.getItem('bc_uid') || '' },
  };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch('/api/' + path, opt);
  let out = {};
  try { out = await res.json(); } catch {}
  if (out && out.error === 'Login required') logout(true);
  return out;
}

function logout(quiet) {
  if (!quiet && !confirm('Log out?')) return;
  localStorage.removeItem('bc_uid');
  localStorage.removeItem('bc_user');
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
