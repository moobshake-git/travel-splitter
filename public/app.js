// Travel Splitter front end (vanilla JS).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  people: [],
  trips: [],
  tripId: localStorage.getItem('tripId') || null,
  me: '',        // logged-in person's id
  user: null,    // logged-in person
  expenses: [],
  summary: null,
  editing: { person: null, trip: null, expense: null },
  split: { mode: 'equal', rows: {} }, // rows[personId] = { on: bool, value: string }
};

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) { showAuth(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- formatting ----------
const trip = () => state.trips.find((t) => t.id === state.tripId);
const personName = (id) => state.people.find((p) => p.id === id)?.name ?? 'Unknown';
function money(cents, currency = trip()?.currency || 'USD') {
  const v = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- loading ----------
async function loadAll() {
  [state.people, state.trips] = await Promise.all([api('GET', '/api/people'), api('GET', '/api/trips')]);
  if (!state.trips.some((t) => t.id === state.tripId)) state.tripId = state.trips[0]?.id || null;
  await loadTrip();
  render();
}
async function loadTrip() {
  if (!state.tripId) { state.expenses = []; state.summary = null; return; }
  [state.expenses, state.summary] = await Promise.all([
    api('GET', `/api/trips/${state.tripId}/expenses`),
    api('GET', `/api/trips/${state.tripId}/summary`),
  ]);
}

// ---------- render ----------
function render() {
  try { if (state.tripId) localStorage.setItem('tripId', state.tripId); else localStorage.removeItem('tripId'); } catch {}

  $('#meName').textContent = state.people.find((p) => p.id === state.me)?.name || state.user?.name || '';

  // People
  $('#peopleCount').textContent = `(${state.people.length}/10)`;
  $('#newPersonBtn').disabled = state.people.length >= 10;
  $('#peopleList').innerHTML = state.people.length
    ? state.people.map((p) => `
      <li>
        <span>${esc(p.name)}${p.id === state.me ? ' <span class="tag">you</span>' : p.hasAccount ? '' : ' <span class="tag" title="Hasn\'t created an account yet">invited</span>'}</span>
        <span class="row-actions">
          ${p.id === state.me || !p.hasAccount ? `<button class="icon-btn" title="Rename" data-edit-person="${p.id}">✎</button>` : ''}
          ${!p.hasAccount ? `<button class="icon-btn" title="Remove" data-del-person="${p.id}">🗑</button>` : ''}
        </span>
      </li>`).join('')
    : `<li class="empty-note">No one yet — add your travel group.</li>`;

  // Trips
  $('#tripList').innerHTML = state.trips.length
    ? state.trips.map((t) => `
      <li class="clickable ${t.id === state.tripId ? 'active' : ''}" data-trip="${t.id}">
        <span>${esc(t.name)}</span><span class="muted">${t.memberIds.length} 👤</span>
      </li>`).join('')
    : `<li class="empty-note">No trips yet.</li>`;

  const t = trip();
  $('#emptyState').hidden = !!t;
  $('#tripView').hidden = !t;
  if (t) renderTrip(t);
}

function renderTrip(t) {
  const s = state.summary;
  $('#tripName').textContent = t.name;
  $('#deleteTripBtn').hidden = !!t.createdBy && t.createdBy !== state.me;
  $('#tripMembers').textContent = `${t.currency} · ${t.memberIds.map(personName).join(', ')}`;
  $('#statTotal').textContent = money(s.totalCents);
  $('#statCount').textContent = state.expenses.length;

  const mine = s.people.find((p) => p.personId === state.me);
  if (mine) {
    const b = mine.balanceCents;
    $('#statMineLabel').textContent = b > 0 ? 'You are owed' : b < 0 ? 'You owe' : 'Your balance';
    $('#statMine').innerHTML = `<span class="${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}">${money(Math.abs(b))}</span>`;
  } else {
    $('#statMineLabel').textContent = 'Your balance';
    $('#statMine').innerHTML = `<span class="muted" style="font-size:.9rem;font-weight:400">Not on this trip</span>`;
  }

  $('#balanceBody').innerHTML = s.people.map((p) => {
    const b = p.balanceCents;
    const cls = b > 0 ? 'pos' : b < 0 ? 'neg' : 'muted';
    const label = b > 0 ? `gets back ${money(b)}` : b < 0 ? `owes ${money(-b)}` : 'settled';
    return `<tr>
      <td>${esc(personName(p.personId))}${p.personId === state.me ? ' <span class="tag">you</span>' : ''}</td>
      <td class="num">${money(p.paidCents)}</td>
      <td class="num">${money(p.owedCents)}</td>
      <td class="num ${cls}">${label}</td>
    </tr>`;
  }).join('');

  $('#transferList').innerHTML = s.transfers.length
    ? s.transfers.map((x) => `
      <li><span><b>${esc(personName(x.from))}</b> pays <b>${esc(personName(x.to))}</b></span><span class="amt">${money(x.cents)}</span></li>`).join('')
    : `<li class="muted" style="background:none;padding:0">${state.expenses.length ? 'Everyone is settled up 🎉' : 'Add an expense to see who owes whom.'}</li>`;

  renderExpenses();
}

const MODE_LABEL = { equal: 'split evenly', exact: 'exact amounts', percent: 'by percent', shares: 'by shares' };
function renderExpenses() {
  const q = $('#search').value.trim().toLowerCase();
  const list = state.expenses.filter((e) => !q ||
    e.description.toLowerCase().includes(q) || e.category.toLowerCase().includes(q) ||
    personName(e.paidBy).toLowerCase().includes(q));
  if (!list.length) {
    $('#expenseList').innerHTML = `<p class="muted">${state.expenses.length ? 'No matches.' : 'No expenses yet. Click “+ Add expense”.'}</p>`;
    return;
  }
  $('#expenseList').innerHTML = list.map((e) => {
    const d = new Date(e.date + 'T00:00:00');
    const mon = d.toLocaleString(undefined, { month: 'short' });
    const who = e.shares.map((sh) => `${esc(personName(sh.personId))} ${money(sh.cents)}`).join(' · ');
    return `<div class="expense">
      <div class="date">${mon}<b>${d.getDate()}</b></div>
      <div>
        <div class="title">${esc(e.description)}<span class="tag">${esc(e.category)}</span></div>
        <div class="meta">${esc(personName(e.paidBy))} paid · ${MODE_LABEL[e.splitMode]} among ${e.shares.length}${e.createdBy && e.createdBy !== e.paidBy ? ' · added by ' + esc(personName(e.createdBy)) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div>
        <div class="split-detail">${who}</div>
      </div>
      <div class="amount">${money(e.amountCents)}</div>
      <div class="row-actions">
        ${e.canEdit ? `<button class="icon-btn" title="Edit" data-edit-exp="${e.id}">✎</button>
        <button class="icon-btn" title="Delete" data-del-exp="${e.id}">🗑</button>` : `<span class="icon-btn" title="Only the person who added or paid can change this">🔒</span>`}
      </div>
    </div>`;
  }).join('');
}

// ---------- dialogs: generic ----------
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- people CRUD ----------
function openPerson(p) {
  state.editing.person = p || null;
  $('#personDialogTitle').textContent = p ? 'Rename person' : 'Add person';
  $('#personForm').name.value = p?.name || '';
  $('#personError').textContent = '';
  $('#personDialog').showModal();
}
$('#newPersonBtn').onclick = () => openPerson();
$('#personForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = ev.target.name.value;
  try {
    const p = state.editing.person;
    if (p) await api('PUT', `/api/people/${p.id}`, { name });
    else await api('POST', '/api/people', { name });
    $('#personDialog').close();
    await loadAll();
    toast(p ? 'Renamed' : 'Person added');
  } catch (e) { $('#personError').textContent = e.message; }
});
$('#peopleList').addEventListener('click', async (ev) => {
  const edit = ev.target.closest('[data-edit-person]');
  const del = ev.target.closest('[data-del-person]');
  if (edit) openPerson(state.people.find((p) => p.id === edit.dataset.editPerson));
  if (del) {
    const p = state.people.find((x) => x.id === del.dataset.delPerson);
    if (!confirm(`Remove ${p.name}? They'll be taken off any trips they're on.`)) return;
    try { await api('DELETE', `/api/people/${p.id}`); await loadAll(); toast('Person removed'); }
    catch (e) { alert(e.message); }
  }
});

// ---------- trip CRUD ----------
function openTrip(t) {
  if (!state.people.length) { toast('Add some people first'); openPerson(); return; }
  state.editing.trip = t || null;
  const f = $('#tripForm');
  $('#tripDialogTitle').textContent = t ? 'Edit trip' : 'New trip';
  f.name.value = t?.name || '';
  f.currency.value = t?.currency || 'USD';
  const members = new Set(t ? t.memberIds : state.people.map((p) => p.id));
  $('#tripMembersPick').innerHTML = state.people.map((p) => p.id === state.me
    ? `<label title="You're always on trips you create"><input type="checkbox" value="${p.id}" checked disabled> ${esc(p.name)} (you)</label>`
    : `<label><input type="checkbox" value="${p.id}" ${members.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('');
  $('#tripError').textContent = '';
  $('#tripDialog').showModal();
}
$('#newTripBtn').onclick = () => openTrip();
$('#editTripBtn').onclick = () => openTrip(trip());
$('#tripForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = {
    name: f.name.value,
    currency: f.currency.value.toUpperCase(),
    memberIds: [...$('#tripMembersPick').querySelectorAll('input:checked')].map((i) => i.value),
  };
  try {
    const t = state.editing.trip;
    const saved = t ? await api('PUT', `/api/trips/${t.id}`, body) : await api('POST', '/api/trips', body);
    state.tripId = saved.id;
    $('#tripDialog').close();
    await loadAll();
    toast(t ? 'Trip updated' : 'Trip created');
  } catch (e) { $('#tripError').textContent = e.message; }
});
$('#deleteTripBtn').onclick = async () => {
  const t = trip();
  if (!confirm(`Delete "${t.name}" and all ${state.expenses.length} of its expenses? This can't be undone.`)) return;
  await api('DELETE', `/api/trips/${t.id}`);
  state.tripId = null;
  await loadAll();
  toast('Trip deleted');
};
$('#tripList').addEventListener('click', async (ev) => {
  const li = ev.target.closest('[data-trip]');
  if (!li) return;
  state.tripId = li.dataset.trip;
  await loadTrip();
  render();
});

// ---------- expense CRUD + split editor ----------
const HINTS = {
  equal: 'Tick who shared this. The amount is divided evenly (leftover cents go to the first people).',
  exact: 'Type exactly how much each person owes. It must add up to the total.',
  percent: 'Give each person a percentage. It must add up to 100%.',
  shares: 'Give weights, e.g. 2 for someone who had double. 0 = not included.',
};

// Mirror of the server's rounding so the preview matches what gets saved.
function distribute(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const fl = raw.map(Math.floor);
  let left = total - fl.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - fl[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  return fl;
}

function activeRows() {
  const t = trip();
  const { mode, rows } = state.split;
  return t.memberIds.filter((id) => {
    const r = rows[id];
    if (mode === 'equal') return r.on;
    return r.value !== '' && Number(r.value) > 0;
  });
}

function renderSplit() {
  const t = trip();
  const { mode, rows } = state.split;
  document.querySelectorAll('#splitMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#splitHint').textContent = HINTS[mode];
  const unit = mode === 'exact' ? t.currency : mode === 'percent' ? '%' : '×';
  $('#splitRows').innerHTML = t.memberIds.map((id) => {
    const r = rows[id];
    const control = mode === 'equal'
      ? `<span></span>`
      : `<input type="number" step="${mode === 'shares' ? '0.5' : '0.01'}" min="0" placeholder="0 ${unit}" data-split-val="${id}" value="${esc(r.value)}">`;
    return `<div class="split-row">
      <label class="who">${mode === 'equal' ? `<input type="checkbox" data-split-on="${id}" ${r.on ? 'checked' : ''}>` : ''}${esc(personName(id))}</label>
      ${control}
      <span class="share" data-share="${id}"></span>
    </div>`;
  }).join('');
  updateSplitPreview();
}

function updateSplitPreview() {
  const t = trip();
  const { mode, rows } = state.split;
  const total = Math.round((Number($('#expenseForm').amount.value) || 0) * 100);
  const ids = activeRows();
  let shares = {};
  let foot = '';
  if (mode === 'equal') {
    distribute(total, ids.map(() => 1)).forEach((c, i) => (shares[ids[i]] = c));
    foot = `<span>${ids.length} ${ids.length === 1 ? 'person' : 'people'}</span><span>${ids.length ? money(Math.floor(total / ids.length), t.currency) + ' each' : ''}</span>`;
  } else if (mode === 'exact') {
    let sum = 0;
    ids.forEach((id) => { const c = Math.round(Number(rows[id].value) * 100); shares[id] = c; sum += c; });
    const diff = total - sum;
    foot = `<span>Assigned ${money(sum, t.currency)} of ${money(total, t.currency)}</span>` +
      (diff === 0 ? `<span class="good">✓ Balanced</span>` : `<span class="bad">${money(Math.abs(diff), t.currency)} ${diff > 0 ? 'left to assign' : 'too much'}</span>`);
  } else {
    const w = ids.map((id) => Number(rows[id].value));
    distribute(total, w).forEach((c, i) => (shares[ids[i]] = c));
    if (mode === 'percent') {
      const p = +w.reduce((a, b) => a + b, 0).toFixed(3);
      foot = `<span>Total ${p}%</span>` + (Math.abs(p - 100) < 0.001 ? `<span class="good">✓ Balanced</span>` : `<span class="bad">${+(100 - p).toFixed(3)}% ${p < 100 ? 'left' : 'over'}</span>`);
    } else {
      foot = `<span>${w.reduce((a, b) => a + b, 0)} total shares</span><span></span>`;
    }
  }
  t.memberIds.forEach((id) => {
    const el = document.querySelector(`[data-share="${id}"]`);
    if (el) el.textContent = shares[id] != null ? money(shares[id], t.currency) : '—';
  });
  $('#splitFoot').innerHTML = foot;
}

function openExpense(e) {
  const t = trip();
  state.editing.expense = e || null;
  const f = $('#expenseForm');
  $('#expenseDialogTitle').textContent = e ? 'Edit expense' : 'Add expense';
  f.paidBy.innerHTML = t.memberIds.map((id) => `<option value="${id}">${esc(personName(id))}</option>`).join('');
  f.description.value = e?.description || '';
  f.amount.value = e ? (e.amountCents / 100).toFixed(2) : '';
  f.date.value = e?.date || new Date().toISOString().slice(0, 10);
  f.category.value = e?.category || 'Food';
  f.notes.value = e?.notes || '';
  f.paidBy.value = e?.paidBy || (t.memberIds.includes(state.me) ? state.me : t.memberIds[0]);

  const rows = {};
  for (const id of t.memberIds) {
    const sh = e?.shares.find((s) => s.personId === id);
    rows[id] = { on: e ? !!sh : true, value: sh && sh.value != null ? String(sh.value) : '' };
  }
  state.split = { mode: e?.splitMode || 'equal', rows };
  $('#expenseError').textContent = '';
  renderSplit();
  $('#expenseDialog').showModal();
  f.description.focus();
}

$('#addExpenseBtn').onclick = () => openExpense();
$('#splitMode').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-mode]');
  if (!b) return;
  const { rows } = state.split;
  const prev = state.split.mode;
  const next = b.dataset.mode;
  if (prev === next) return;
  // Carry over who's included as a sensible starting point.
  const included = prev === 'equal'
    ? Object.keys(rows).filter((id) => rows[id].on)
    : Object.keys(rows).filter((id) => Number(rows[id].value) > 0);
  const total = Number($('#expenseForm').amount.value) || 0;
  const evenCents = distribute(Math.round(total * 100), included.map(() => 1));
  for (const id of Object.keys(rows)) {
    const idx = included.indexOf(id);
    rows[id].on = idx >= 0;
    if (next === 'exact') rows[id].value = idx >= 0 && total ? (evenCents[idx] / 100).toFixed(2) : '';
    if (next === 'percent') rows[id].value = idx >= 0 ? String(+(100 / included.length).toFixed(4)) : '';
    if (next === 'shares') rows[id].value = idx >= 0 ? '1' : '';
  }
  state.split.mode = next;
  renderSplit();
});
$('#splitRows').addEventListener('input', (ev) => {
  const on = ev.target.dataset.splitOn;
  const val = ev.target.dataset.splitVal;
  if (on) state.split.rows[on].on = ev.target.checked;
  if (val) state.split.rows[val].value = ev.target.value;
  updateSplitPreview();
});
$('#expenseForm').amount.addEventListener('input', updateSplitPreview);

$('#expenseForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const { mode, rows } = state.split;
  const body = {
    tripId: state.tripId,
    description: f.description.value,
    amount: f.amount.value,
    paidBy: f.paidBy.value,
    date: f.date.value,
    category: f.category.value,
    notes: f.notes.value,
    splitMode: mode,
    splits: activeRows().map((id) => (mode === 'equal' ? { personId: id } : { personId: id, value: rows[id].value })),
  };
  try {
    const e = state.editing.expense;
    if (e) await api('PUT', `/api/expenses/${e.id}`, body);
    else await api('POST', '/api/expenses', body);
    $('#expenseDialog').close();
    await loadTrip();
    render();
    toast(e ? 'Expense updated' : 'Expense added');
  } catch (err) { $('#expenseError').textContent = err.message; }
});

$('#expenseList').addEventListener('click', async (ev) => {
  const edit = ev.target.closest('[data-edit-exp]');
  const del = ev.target.closest('[data-del-exp]');
  if (edit) openExpense(state.expenses.find((x) => x.id === edit.dataset.editExp));
  if (del) {
    const e = state.expenses.find((x) => x.id === del.dataset.delExp);
    if (!confirm(`Delete "${e.description}" (${money(e.amountCents)})?`)) return;
    await api('DELETE', `/api/expenses/${e.id}`);
    await loadTrip();
    render();
    toast('Expense deleted');
  }
});
$('#search').addEventListener('input', renderExpenses);

// ---------- accounts: log in / sign up / log out ----------
async function showAuth(tab) {
  state.user = null; state.me = '';
  $('#authScreen').hidden = false;
  $('#registerError').textContent = '';
  switchAuthTab(tab || 'login');
}
function hideAuth() { $('#authScreen').hidden = true; }
function switchAuthTab(tab) {
  document.querySelectorAll('#authTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#loginForm').hidden = tab !== 'login';
  $('#registerForm').hidden = tab !== 'register';
  (tab === 'login' ? $('#loginForm') : $('#registerForm')).querySelector('input:not([hidden])')?.focus();
}
async function signedIn(user) {
  state.user = user; state.me = user.id;
  hideAuth();
  $('#loginForm').reset(); $('#registerForm').reset();
  $('#loginError').textContent = ''; $('#registerError').textContent = '';
  await loadAll();
}

$('#authTabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) switchAuthTab(b.dataset.tab); });

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const { user } = await api('POST', '/api/auth/login', { username: f.username.value, password: f.password.value });
    await signedIn(user);
    toast(`Welcome back, ${user.name}!`);
  } catch (e) { $('#loginError').textContent = e.message; }
});

$('#registerForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.password.value !== f.confirm.value) { $('#registerError').textContent = "Passwords don't match"; return; }
  try {
    const { user } = await api('POST', '/api/auth/register', {
      username: f.username.value, password: f.password.value, name: f.name.value,
    });
    await signedIn(user);
    toast(`Welcome, ${user.name}!`);
  } catch (e) { $('#registerError').textContent = e.message; }
});

$('#logoutBtn').onclick = async () => {
  await api('POST', '/api/auth/logout');
  state.people = []; state.trips = []; state.expenses = []; state.summary = null;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  showAuth();
};

$('#passwordBtn').onclick = () => { $('#passwordForm').reset(); $('#passwordError').textContent = ''; $('#passwordDialog').showModal(); };
$('#passwordForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.next.value !== f.confirm.value) { $('#passwordError').textContent = "New passwords don't match"; return; }
  try {
    await api('POST', '/api/auth/password', { current: f.current.value, next: f.next.value });
    $('#passwordDialog').close();
    toast('Password updated');
  } catch (e) { $('#passwordError').textContent = e.message; }
});

// ---------- start ----------
(async () => {
  try {
    const { user } = await api('GET', '/api/auth/me');
    if (user) await signedIn(user); else await showAuth();
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin', `<p class="error" style="padding:1rem">Could not reach the server: ${esc(e.message)}</p>`);
  }
})();
