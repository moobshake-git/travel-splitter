// Travel Splitter front end (vanilla JS). Split math comes from shared.js (window.Shared).
const { distributeUnits, percentTotalOk, parseAmount, currencyDigits, unitCents, localToday, CATEGORIES, DEFAULT_CATEGORY } = window.Shared;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Icon-only button with a real accessible name (the emoji itself is hidden from screen
// readers, which would read "wastebasket") (#10).
const iconBtn = (icon, label, attrs) =>
  `<button type="button" class="icon-btn" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}><span aria-hidden="true">${icon}</span></button>`;

const state = {
  people: [],
  trips: [],
  tripId: localStorage.getItem('tripId') || null,
  me: '',        // logged-in person's id
  user: null,    // logged-in person
  maxPeople: 10, // group size limit, from /api/auth/me
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
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    showAuth('Your session has ended. Please log in again.');
    throw Object.assign(new Error('Please log in'), { status: 401, sessionEnded: true });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// Run an action with its button disabled (and aria-busy), so a double click can't
// submit twice (#7).
async function busy(btn, fn) {
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try {
    return await fn();
  } finally {
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
}

// Show an error where the user is looking: in the open dialog's error line, or as a toast.
// Errors outside a form (or "not found / not allowed / changed meanwhile") usually mean our
// copy is out of date, so reload it from the server (#7).
async function showError(e, el) {
  if (e.sessionEnded) return; // already back on the login screen
  if (el) el.textContent = e.message; else toast(e.message);
  if (state.me && (!el || [403, 404, 409].includes(e.status))) {
    try { await loadAll(); } catch { /* reported already */ }
  }
}

// ---------- formatting ----------
const trip = () => state.trips.find((t) => t.id === state.tripId);
// Recorded payments ("Ben paid Ana back") live alongside expenses but aren't spending (#19).
const isPayment = (e) => e.kind === 'settlement';
// Amount typed in a form → hundredths, or 0 while it isn't a valid amount yet (for previews).
const amountCents = (v, currency = trip()?.currency) => parseAmount(v, currency).cents || 0;
// Hundredths → the text to put in an amount input (no decimals for JPY etc.).
const amountText = (cents, currency = trip()?.currency) => (cents / 100).toFixed(currencyDigits(currency));
const personName = (id) => state.people.find((p) => p.id === id)?.name ?? 'Unknown';
function money(cents, currency = trip()?.currency || 'USD') {
  const v = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(v);
  } catch {
    // Invalid code (e.g. old data): keep letters only so this can never inject HTML (#1).
    const code = String(currency).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || '¤';
    return `${code} ${v.toFixed(2)}`;
  }
}
// #toast is a polite live region that stays in the page, so screen readers announce each
// message; it's only visually hidden while empty (#10).
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.textContent = ''), 4000);
}

// Move focus somewhere sensible after a re-render destroyed the button that had it (#10).
// Tries each selector in turn and focuses the first visible match.
function focusFirst(...selectors) {
  requestAnimationFrame(() => {
    for (const sel of selectors) {
      const el = sel && $(sel);
      if (el && !el.closest('[hidden]') && !el.disabled) { el.focus(); return; }
    }
  });
}

// A styled, accessible replacement for confirm(). Resolves true if confirmed (#10).
function confirmDialog(text, { title = 'Are you sure?', ok = 'OK', danger = false } = {}) {
  const d = $('#confirmDialog');
  const okBtn = $('#confirmOk');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger-fill', danger);
  d.returnValue = '';
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
    // Destructive actions start on Cancel, so Enter doesn't delete by accident.
    (danger ? d.querySelector('[data-close]') : okBtn).focus();
  });
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
  [state.expenses, state.summary] = await fetchTrip(state.tripId);
}
const fetchTrip = (id) => Promise.all([api('GET', `/api/trips/${id}/expenses`), api('GET', `/api/trips/${id}/summary`)]);

// Switch trips only once the new one has loaded, so a failure (e.g. you were removed from it)
// can't leave the old trip's data on screen under the new trip's id (#7).
async function selectTrip(id) {
  const [expenses, summary] = await fetchTrip(id);
  Object.assign(state, { tripId: id, expenses, summary });
  render();
  focusFirst(`.trip-btn[data-trip="${id}"]`);
  // On phones the trip is below the trip strip: bring it into view (#10).
  if (matchMedia('(max-width: 820px)').matches) $('#tripView').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- render ----------
function render() {
  try { if (state.tripId) localStorage.setItem('tripId', state.tripId); else localStorage.removeItem('tripId'); } catch { /* storage blocked: just don't remember the trip */ }

  $('#meName').textContent = state.people.find((p) => p.id === state.me)?.name || state.user?.name || '';

  // People
  $('#peopleCount').textContent = `(${state.people.length}/${state.maxPeople})`;
  $('#newPersonBtn').disabled = state.people.length >= state.maxPeople;
  $('#maxPeopleNote').textContent = state.maxPeople;
  $('#peopleList').innerHTML = state.people.length
    ? state.people.map((p) => `
      <li>
        <span>${esc(p.name)}${p.id === state.me ? ' <span class="tag">you</span>' : p.hasAccount ? '' : ' <span class="tag" title="Hasn\'t created an account yet">invited</span>'}</span>
        <span class="row-actions">
          ${p.inviteCode ? iconBtn('🔗', `Show invite code for ${p.name}`, `data-invite-person="${p.id}"`) : ''}
          ${p.id === state.me || p.canManage ? iconBtn('✎', `Rename ${p.name}`, `data-edit-person="${p.id}"`) : ''}
          ${p.canManage ? iconBtn('🗑', `Remove ${p.name}`, `data-del-person="${p.id}"`) : ''}
        </span>
      </li>`).join('')
    : `<li class="empty-note">No one yet — add your travel group.</li>`;

  // Trips
  $('#tripList').innerHTML = state.trips.length
    ? state.trips.map((t) => `
      <li><button type="button" class="trip-btn" data-trip="${t.id}" ${t.id === state.tripId ? 'aria-current="true"' : ''}>
        <span>${esc(t.name)}</span>
        <span class="muted">${t.memberIds.length}<span aria-hidden="true"> 👤</span><span class="sr-only"> people</span></span>
      </button></li>`).join('')
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
  $('#statCount').textContent = state.expenses.filter((e) => !isPayment(e)).length;

  const mine = s.people.find((p) => p.personId === state.me);
  if (mine) {
    const b = mine.balanceCents;
    $('#statMineLabel').textContent = b > 0 ? 'You are owed' : b < 0 ? 'You owe' : 'Your balance';
    $('#statMine').innerHTML = `<span class="${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}">${money(Math.abs(b))}</span>`;
  } else {
    $('#statMineLabel').textContent = 'Your balance';
    $('#statMine').innerHTML = `<span class="muted stat-note">Not on this trip</span>`;
  }

  $('#balanceBody').innerHTML = s.people.map((p) => {
    const b = p.balanceCents;
    const cls = b > 0 ? 'pos' : b < 0 ? 'neg' : 'muted';
    const label = b > 0 ? `gets back ${money(b)}` : b < 0 ? `owes ${money(-b)}` : 'settled';
    const moved = [p.sentCents && `paid back ${money(p.sentCents)}`, p.receivedCents && `got back ${money(p.receivedCents)}`].filter(Boolean).join(', ');
    return `<tr>
      <td>${esc(personName(p.personId))}${p.personId === state.me ? ' <span class="tag">you</span>' : ''}${moved ? `<div class="sub">${moved}</div>` : ''}</td>
      <td class="num">${money(p.paidCents)}</td>
      <td class="num">${money(p.owedCents)}</td>
      <td class="num ${cls}">${label}</td>
    </tr>`;
  }).join('');

  $('#transferList').innerHTML = s.transfers.length
    ? s.transfers.map((x, i) => `
      <li><span><b>${esc(personName(x.from))}</b> pays <b>${esc(personName(x.to))}</b></span>
        <span class="amt">${money(x.cents)}</span>
        ${x.from === state.me || x.to === state.me ? `<button class="btn small" data-mark-paid="${i}">Mark paid</button>` : ''}</li>`).join('')
    : `<li class="muted transfers-note">${state.expenses.length ? 'Everyone is settled up 🎉' : 'Add an expense to see who owes whom.'}</li>`;

  renderExpenses();
}

const MODE_LABEL = { equal: 'split evenly', exact: 'exact amounts', percent: 'by percent', shares: 'by shares' };
// Everything a search can match: description, category, notes, who paid and who shared it (#20).
const searchText = (e) => [e.description, e.category, e.notes, personName(e.paidBy), ...e.shares.map((s) => personName(s.personId))]
  .join('\n').toLowerCase();
function renderExpenses() {
  const search = $('#search');
  // A search belongs to one trip: start fresh when you switch (#20).
  if (search.dataset.forTrip !== state.tripId) { search.value = ''; search.dataset.forTrip = state.tripId || ''; }
  const q = search.value.trim().toLowerCase();
  const list = state.expenses.filter((e) => !q || searchText(e).includes(q));
  if (!list.length) {
    $('#expenseList').innerHTML = !state.expenses.length
      ? '<p class="muted">No expenses yet. Click “+ Add expense”.</p>'
      : `<p class="muted">No matches for “${esc(search.value.trim())}”. <button type="button" class="btn small" id="clearSearchBtn">Clear search</button></p>`;
    return;
  }
  $('#expenseList').innerHTML = list.map((e) => {
    const d = new Date(e.date + 'T00:00:00');
    const mon = d.toLocaleString(undefined, { month: 'short' });
    if (isPayment(e)) {
      const to = e.shares[0]?.personId;
      return `<div class="expense payment">
        <div class="date">${mon}<b>${d.getDate()}</b></div>
        <div>
          <div class="title">💸 ${esc(personName(e.paidBy))} paid ${esc(personName(to))}<span class="tag">payment</span></div>
          <div class="meta">Settling up${e.createdBy ? ' · recorded by ' + esc(personName(e.createdBy)) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div>
        </div>
        <div class="amount">${money(e.amountCents)}</div>
        <div class="row-actions">
          ${e.canEdit ? iconBtn('🗑', `Delete payment from ${personName(e.paidBy)} to ${personName(to)}`, `data-del-exp="${e.id}"`) : ''}
        </div>
      </div>`;
    }
    const who = e.shares.map((sh) => `${esc(personName(sh.personId))} ${money(sh.cents)}`).join(' · ');
    return `<div class="expense">
      <div class="date">${mon}<b>${d.getDate()}</b></div>
      <div>
        <div class="title">${esc(e.description)}<span class="tag">${esc(e.category)}</span></div>
        <div class="meta">${esc(personName(e.paidBy))} paid · ${MODE_LABEL[e.splitMode]} among ${e.shares.length}${e.createdBy && e.createdBy !== e.paidBy ? ' · added by ' + esc(personName(e.createdBy)) : ''}${e.updatedBy && e.updatedBy !== e.createdBy ? ' · edited by ' + esc(personName(e.updatedBy)) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div>
        <div class="split-detail">${who}</div>
      </div>
      <div class="amount">${money(e.amountCents)}</div>
      <div class="row-actions">
        ${e.canEdit ? `${iconBtn('✎', `Edit ${e.description}`, `data-edit-exp="${e.id}"`)}
        ${iconBtn('🗑', `Delete ${e.description}`, `data-del-exp="${e.id}"`)}`
    : `<span class="view-only" title="Only the person who added or paid can change this"><span aria-hidden="true">🔒</span> View only</span>`}
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
$('#newPersonBtn').addEventListener('click', () => openPerson());
$('#personForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = ev.target.name.value;
  return busy(ev.submitter, async () => {
    try {
      const p = state.editing.person;
      const saved = p ? await api('PUT', `/api/people/${p.id}`, { name }) : await api('POST', '/api/people', { name });
      $('#personDialog').close();
      await loadAll();
      if (p) { toast('Renamed'); focusFirst(`[data-edit-person="${p.id}"]`, '#newPersonBtn'); }
      else showInvite(saved);
    } catch (e) { showError(e, $('#personError')); }
  });
});
const formatCode = (c) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : '');
function showInvite(p) {
  $('#inviteName').textContent = p.name;
  $('#inviteCode').textContent = formatCode(p.inviteCode);
  $('#inviteDialog').showModal();
}
$('#copyInviteBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#inviteCode').textContent); toast('Invite code copied'); }
  catch { toast('Copy failed — select the code and copy it manually'); }
});
$('#peopleList').addEventListener('click', async (ev) => {
  const edit = ev.target.closest('[data-edit-person]');
  const del = ev.target.closest('[data-del-person]');
  const invite = ev.target.closest('[data-invite-person]');
  if (invite) showInvite(state.people.find((p) => p.id === invite.dataset.invitePerson));
  if (edit) openPerson(state.people.find((p) => p.id === edit.dataset.editPerson));
  if (del) {
    const p = state.people.find((x) => x.id === del.dataset.delPerson);
    if (!(await confirmDialog(`They'll be taken off any trips they're on.`, { title: `Remove ${p.name}?`, ok: 'Remove', danger: true }))) return;
    await busy(del, async () => {
      try { await api('DELETE', `/api/people/${p.id}`); await loadAll(); toast('Person removed'); focusFirst('#newPersonBtn'); }
      catch (e) { showError(e); }
    });
  }
});

// ---------- trip CRUD ----------
// Currency suggestions for the trip form (ISO 4217 codes the browser knows).
try {
  $('#currencyList').innerHTML = Intl.supportedValuesOf('currency').map((c) => `<option value="${c}">`).join('');
} catch { /* older browser: free text still works */ }

function openTrip(t) {
  if (!state.people.length) { toast('Add some people first'); openPerson(); return; }
  state.editing.trip = t || null;
  const f = $('#tripForm');
  $('#tripDialogTitle').textContent = t ? 'Edit trip' : 'New trip';
  f.name.value = t?.name || '';
  f.currency.value = t?.currency || 'USD';
  // Amounts aren't converted, so the currency is fixed once a trip has expenses (#18).
  const locked = !!t && t.id === state.tripId && state.expenses.length > 0;
  f.currency.disabled = locked;
  $('#currencyNote').hidden = !locked;
  const members = new Set(t ? t.memberIds : state.people.map((p) => p.id));
  const creator = t ? t.createdBy : state.me;
  // You can't remove yourself, and nobody can remove the trip's creator (#3).
  $('#tripMembersPick').innerHTML = state.people.map((p) => {
    const locked = p.id === state.me || p.id === creator;
    const note = [p.id === state.me && 'you', p.id === creator && 'creator'].filter(Boolean).join(', ');
    return locked
      ? `<label title="Can't be removed from this trip"><input type="checkbox" value="${p.id}" checked disabled> ${esc(p.name)} (${note})</label>`
      : `<label><input type="checkbox" value="${p.id}" ${members.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`;
  }).join('');
  $('#tripError').textContent = '';
  $('#tripDialog').showModal();
}
$('#newTripBtn').addEventListener('click', () => openTrip());
// Reload first, so the form starts from the latest version of the trip (#18).
$('#editTripBtn').addEventListener('click', async () => {
  try { await loadAll(); } catch (e) { toast(e.message); return; }
  openTrip(trip());
});
$('#tripForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  return busy(ev.submitter, () => saveTrip(ev.target));
});
async function saveTrip(f) {
  const body = {
    name: f.name.value,
    currency: f.currency.value.toUpperCase(),
    memberIds: [...$('#tripMembersPick').querySelectorAll('input:checked')].map((i) => i.value),
  };
  const t = state.editing.trip;
  if (t) body.expectedUpdatedAt = t.updatedAt || t.createdAt || null;
  try {
    const saved = t ? await api('PUT', `/api/trips/${t.id}`, body) : await api('POST', '/api/trips', body);
    state.tripId = saved.id;
    $('#tripDialog').close();
    await loadAll();
    toast(t ? 'Trip updated' : 'Trip created');
    focusFirst(t ? '#editTripBtn' : '#addExpenseBtn');
  } catch (e) {
    if (e.status === 409) {
      // Someone else saved first: reload and show their version so nothing gets undone.
      try { await loadAll(); openTrip(trip()); } catch { /* shown below */ }
      $('#tripError').textContent = e.message;
      return;
    }
    showError(e, $('#tripError'));
  }
}
$('#deleteTripBtn').addEventListener('click', async (ev) => {
  const t = trip();
  const btn = ev.currentTarget;
  if (!(await confirmDialog(`It has ${state.expenses.length} expense${state.expenses.length === 1 ? '' : 's'}. This can't be undone.`,
    { title: `Delete “${t.name}”?`, ok: 'Delete trip', danger: true }))) return;
  await busy(btn, async () => {
    try {
      await api('DELETE', `/api/trips/${t.id}`);
      state.tripId = null;
      await loadAll();
      toast('Trip deleted');
      focusFirst('.trip-btn[aria-current]', '#newTripBtn');
    } catch (e) { showError(e); }
  });
});
$('#tripList').addEventListener('click', async (ev) => {
  const li = ev.target.closest('[data-trip]');
  if (!li || li.dataset.trip === state.tripId) return;
  try { await selectTrip(li.dataset.trip); } catch (e) { showError(e); }
});

// ---------- expense CRUD + split editor ----------
const HINTS = {
  equal: 'Tick who shared this. The amount is divided evenly (leftover cents go to the first people).',
  exact: 'Type exactly how much each person owes. It must add up to the total.',
  percent: 'Give each person a percentage. It must add up to 100%.',
  shares: 'Give weights, e.g. 2 for someone who had double. 0 = not included.',
};

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
      : `<input type="number" step="${mode === 'exact' ? 10 ** -currencyDigits(t.currency) : 'any'}" min="0" placeholder="0 ${unit}" data-split-val="${id}" value="${esc(r.value)}">`;
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
  const total = amountCents($('#expenseForm').amount.value, t.currency);
  const unit = unitCents(t.currency);
  const ids = activeRows();
  const shares = {};
  let foot;
  if (mode === 'equal') {
    distributeUnits(total, ids.map(() => 1), unit).forEach((c, i) => (shares[ids[i]] = c));
    // When it doesn't divide evenly, say so: "$3.33–$3.34 each", not a rounded-down "$3.33 each" (#20).
    const vals = ids.map((id) => shares[id]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const each = !ids.length ? '' : lo === hi ? `${money(lo, t.currency)} each` : `${money(lo, t.currency)}–${money(hi, t.currency)} each`;
    foot = `<span>${ids.length} ${ids.length === 1 ? 'person' : 'people'}</span><span>${each}</span>`;
  } else if (mode === 'exact') {
    let sum = 0;
    ids.forEach((id) => { const c = amountCents(rows[id].value, t.currency); shares[id] = c; sum += c; });
    const diff = total - sum;
    foot = `<span>Assigned ${money(sum, t.currency)} of ${money(total, t.currency)}</span>` +
      (diff === 0 ? `<span class="good">✓ Balanced</span>` : `<span class="bad">${money(Math.abs(diff), t.currency)} ${diff > 0 ? 'left to assign' : 'too much'}</span>`);
  } else {
    const w = ids.map((id) => Number(rows[id].value));
    distributeUnits(total, w, unit).forEach((c, i) => (shares[ids[i]] = c));
    if (mode === 'percent') {
      const p = +w.reduce((a, b) => a + b, 0).toFixed(3);
      // "5% over", not "-5% over" (#20).
      foot = `<span>Total ${p}%</span>` + (percentTotalOk(p) ? `<span class="good">✓ Balanced</span>` : `<span class="bad">${+Math.abs(100 - p).toFixed(3)}% ${p < 100 ? 'left' : 'over'}</span>`);
    } else {
      // Rounded like the percent total: 0.1 + 0.2 shows as 0.3, not 0.30000000000000004 (#20).
      foot = `<span>${+w.reduce((a, b) => a + b, 0).toFixed(3)} total shares</span><span></span>`;
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
  // Whole units only for currencies like JPY (#6).
  const digits = currencyDigits(t.currency);
  f.amount.step = String(10 ** -digits);
  f.amount.min = String(10 ** -digits);
  f.amount.value = e ? amountText(e.amountCents, t.currency) : '';
  f.date.value = e?.date || localToday(); // the user's date, not UTC's (#6)
  // Categories come from shared.js, like the server's. An older expense may use one that's no
  // longer in the list: show it as an extra option rather than an empty select (#21).
  const cats = e?.category && !CATEGORIES.includes(e.category) ? [...CATEGORIES, e.category] : CATEGORIES;
  f.category.innerHTML = cats.map((c) => `<option>${esc(c)}</option>`).join('');
  f.category.value = e?.category || DEFAULT_CATEGORY;
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

$('#addExpenseBtn').addEventListener('click', () => openExpense());
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
  const cur = trip().currency;
  const totalCents = amountCents($('#expenseForm').amount.value, cur);
  const evenCents = distributeUnits(totalCents, included.map(() => 1), unitCents(cur));
  for (const id of Object.keys(rows)) {
    const idx = included.indexOf(id);
    rows[id].on = idx >= 0;
    if (next === 'exact') rows[id].value = idx >= 0 && totalCents ? amountText(evenCents[idx], cur) : '';
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

$('#expenseForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  return busy(ev.submitter, () => saveExpense(ev.target));
});
async function saveExpense(f) {
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
    focusFirst(e && `[data-edit-exp="${e.id}"]`, '#addExpenseBtn');
  } catch (err) { showError(err, $('#expenseError')); }
}

$('#expenseList').addEventListener('click', async (ev) => {
  const edit = ev.target.closest('[data-edit-exp]');
  const del = ev.target.closest('[data-del-exp]');
  if (edit) openExpense(state.expenses.find((x) => x.id === edit.dataset.editExp));
  if (del) {
    const e = state.expenses.find((x) => x.id === del.dataset.delExp);
    const what = isPayment(e) ? `the payment from ${personName(e.paidBy)} to ${personName(e.shares[0]?.personId)}` : `“${e.description}”`;
    if (!(await confirmDialog(`${money(e.amountCents)}. This can't be undone.`, { title: `Delete ${what}?`, ok: 'Delete', danger: true }))) return;
    await busy(del, async () => {
      try {
        await api('DELETE', `/api/expenses/${e.id}`);
        await loadTrip();
        render();
        toast(isPayment(e) ? 'Payment deleted' : 'Expense deleted');
        focusFirst('#addExpenseBtn');
      } catch (err) { showError(err); }
    });
  }
});
$('#search').addEventListener('input', renderExpenses);
$('#expenseList').addEventListener('click', (ev) => {
  if (!ev.target.closest('#clearSearchBtn')) return;
  $('#search').value = '';
  renderExpenses();
  $('#search').focus();
});

// "Mark paid" on a settle-up line records the payment (#19).
$('#transferList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-mark-paid]');
  if (!btn) return;
  const x = state.summary.transfers[Number(btn.dataset.markPaid)];
  if (!(await confirmDialog(`Record that ${personName(x.from)} paid ${personName(x.to)} ${money(x.cents)}?`, { title: 'Mark as paid', ok: 'Record payment' }))) return;
  await busy(btn, async () => {
    try {
      await api('POST', '/api/settlements', { tripId: state.tripId, from: x.from, to: x.to, amount: amountText(x.cents), date: localToday() });
      await loadTrip();
      render();
      toast('Payment recorded');
      focusFirst('[data-mark-paid]', '#addExpenseBtn');
    } catch (e) { showError(e); }
  });
});

// ---------- accounts: log in / sign up / log out ----------
// Back to the login screen (logout, or the session ended). Close every dialog and forget
// everything loaded, so nothing from this session can be seen or submitted by whoever logs in
// next (#7).
function showAuth(message = '') {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  Object.assign(state, {
    user: null, me: '', people: [], trips: [], expenses: [], summary: null,
    editing: { person: null, trip: null, expense: null },
  });
  render();
  $('#authScreen').hidden = false;
  $('#loginError').textContent = message;
  $('#registerError').textContent = '';
  switchAuthTab('login');
}
function hideAuth() { $('#authScreen').hidden = true; }
function switchAuthTab(tab) {
  document.querySelectorAll('#authTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#loginForm').hidden = tab !== 'login';
  $('#registerForm').hidden = tab !== 'register';
  (tab === 'login' ? $('#loginForm') : $('#registerForm')).querySelector('input')?.focus();
}
async function signedIn(user, maxPeople) {
  // Whatever was on screen belonged to the previous session.
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  state.user = user; state.me = user.id;
  if (maxPeople) state.maxPeople = maxPeople;
  hideAuth();
  $('#loginForm').reset(); $('#registerForm').reset();
  $('#loginError').textContent = ''; $('#registerError').textContent = '';
  await loadAll();
}

$('#authTabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) switchAuthTab(b.dataset.tab); });

$('#loginForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  return busy(ev.submitter, async () => {
    try {
      const { user } = await api('POST', '/api/auth/login', { username: f.username.value, password: f.password.value });
      await signedIn(user);
      toast(`Welcome back, ${user.name}!`);
    } catch (e) { $('#loginError').textContent = e.message; }
  });
});

$('#registerForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.password.value !== f.confirm.value) { $('#registerError').textContent = "Passwords don't match"; return; }
  return busy(ev.submitter, async () => {
    try {
      const { user } = await api('POST', '/api/auth/register', {
        username: f.username.value, password: f.password.value, name: f.name.value, inviteCode: f.inviteCode.value,
      });
      await signedIn(user);
      toast(`Welcome, ${user.name}!`);
    } catch (e) { $('#registerError').textContent = e.message; }
  });
});

$('#logoutBtn').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
  try {
    await api('POST', '/api/auth/logout');
    showAuth();
  } catch (e) { showError(e); }
}));

$('#passwordBtn').addEventListener('click', () => { $('#passwordForm').reset(); $('#passwordError').textContent = ''; $('#passwordDialog').showModal(); });
$('#passwordForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.next.value !== f.confirm.value) { $('#passwordError').textContent = "New passwords don't match"; return; }
  return busy(ev.submitter, async () => {
    try {
      await api('POST', '/api/auth/password', { current: f.current.value, next: f.next.value });
      $('#passwordDialog').close();
      toast('Password updated');
    } catch (e) {
      // Too many wrong guesses ends the session (#14).
      if (e.status === 401) showAuth(e.message);
      else showError(e, $('#passwordError'));
    }
  });
});

// ---------- keep shared data fresh ----------
// Other members change things too. Reload when you come back to the tab, and every 45 s while
// it's visible, but never while a dialog is open (it would pull data out from under a form) (#20).
const REFRESH_MS = 45_000;
let lastRefresh = 0;
async function refresh() {
  if (!state.me || document.hidden || document.querySelector('dialog[open]')) return;
  if (Date.now() - lastRefresh < 5_000) return;
  lastRefresh = Date.now();
  try { await loadAll(); } catch (e) { if (!e.sessionEnded) console.warn('Refresh failed:', e.message); }
}
document.addEventListener('visibilitychange', refresh);
window.addEventListener('focus', refresh);
setInterval(refresh, REFRESH_MS);

// ---------- start ----------
(async () => {
  try {
    const { user, maxPeople } = await api('GET', '/api/auth/me');
    if (maxPeople) state.maxPeople = maxPeople;
    if (user) await signedIn(user, maxPeople); else showAuth();
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin', `<p class="error fatal-error">Could not reach the server: ${esc(e.message)}</p>`);
  }
})();
