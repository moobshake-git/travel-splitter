// Travel Splitter — zero-dependency local server.
// Run:            node server.js [port]          then open http://localhost:3000
// Reset password: node server.js reset-password <username> <new-password>
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PEOPLE = 10;
const SESSION_DAYS = 30;
const COOKIE = 'ts_session';
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I look-alikes

// ---------- storage ----------
function load() {
  let d;
  try { d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { d = {}; }
  const data = { people: [], trips: [], expenses: [], sessions: {}, ...d };
  // Older data: invited people had no invite code — give them one so they can still join.
  for (const p of data.people) if (!p.account && !p.inviteCode) p.inviteCode = newInviteCode();
  return data;
}
// 8 characters from a 32-letter alphabet = 40 bits of randomness.
function newInviteCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return s;
}
const normalizeCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');
let db = load();
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
const newId = () => crypto.randomUUID();

// ---------- passwords & sessions ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(password, account) {
  const { hash } = hashPassword(password, account.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(account.hash, 'hex'));
}
function createSession(personId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { personId, expires: Date.now() + SESSION_DAYS * 864e5 };
  return token;
}
function pruneSessions() {
  const now = Date.now();
  for (const [t, s] of Object.entries(db.sessions)) if (s.expires < now) delete db.sessions[t];
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
const sessionCookie = (token, maxAge) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

// Simple brute-force protection: 5 bad attempts per username → 1 minute lockout.
const failures = new Map();

// ---------- CLI: password reset ----------
if (process.argv[2] === 'reset-password') {
  const [, , , username, password] = process.argv;
  const p = db.people.find((x) => x.account?.username === String(username).toLowerCase());
  if (!p || !password || password.length < 6) {
    console.error('Usage: node server.js reset-password <username> <new-password (6+ chars)>');
    process.exit(1);
  }
  p.account = { username: p.account.username, ...hashPassword(password) };
  for (const [t, s] of Object.entries(db.sessions)) if (s.personId === p.id) delete db.sessions[t];
  save();
  console.log(`Password reset for ${p.name} (${p.account.username}).`);
  process.exit(0);
}
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 3000;

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (what) => { throw new HttpError(404, `${what} not found`); };
const forbidden = (msg) => { throw new HttpError(403, msg); };

function cleanName(v, field = 'name') {
  if (typeof v !== 'string' || !v.trim()) bad(`${field} is required`);
  if (v.trim().length > 80) bad(`${field} is too long`);
  return v.trim();
}
function toCents(v, field = 'amount') {
  const n = Number(v);
  if (!Number.isFinite(n)) bad(`${field} must be a number`);
  return Math.round(n * 100);
}
const sharesTrip = (aId, bId) => db.trips.some((t) => t.memberIds.includes(aId) && t.memberIds.includes(bId));
// Who may rename/remove an invited person or see their invite code (#2): whoever added them,
// or someone on a trip with them. Legacy invitees with no recorded adder who are on no trip
// are open to anyone, otherwise they could never be cleaned up.
function canManageInvitee(p, user) {
  if (p.account) return false;
  if (p.addedBy === user.id || sharesTrip(p.id, user.id)) return true;
  return !p.addedBy && !db.trips.some((t) => t.memberIds.includes(p.id));
}
// What the browser is allowed to see about a person (never password data, and only your own username).
function publicPerson(p, viewer) {
  const canManage = !!viewer && canManageInvitee(p, viewer);
  return {
    id: p.id,
    name: p.name,
    hasAccount: !!p.account,
    username: viewer && p.id === viewer.id ? p.account?.username || null : null,
    canManage,
    inviteCode: canManage ? p.inviteCode || null : null,
  };
}

function memberTrip(tripId, user) {
  const trip = db.trips.find((t) => t.id === tripId) || notFound('Trip');
  if (!trip.memberIds.includes(user.id)) forbidden('You are not on this trip');
  return trip;
}

// Turn a split request into per-person shares in cents that always sum to the total.
// mode: 'equal'   -> splits: [{personId}]
//       'exact'   -> splits: [{personId, value}]   value = amount
//       'percent' -> splits: [{personId, value}]   value = percentage
//       'shares'  -> splits: [{personId, value}]   value = weight (e.g. 2 = double share)
function computeShares(totalCents, mode, splits, trip) {
  if (!Array.isArray(splits) || splits.length === 0) bad('Pick at least one person to split with');
  const ids = splits.map((s) => s.personId);
  if (new Set(ids).size !== ids.length) bad('A person appears twice in the split');
  for (const id of ids) if (!trip.memberIds.includes(id)) bad('Split includes someone who is not on this trip');

  // Distribute rounding pennies largest-remainder style so the sum is exact.
  const distribute = (weights) => {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) bad('Split weights must add up to more than zero');
    const raw = weights.map((w) => (totalCents * w) / sum);
    const floored = raw.map(Math.floor);
    let left = totalCents - floored.reduce((a, b) => a + b, 0);
    raw.map((r, i) => [r - floored[i], i])
      .sort((a, b) => b[0] - a[0])
      .forEach(([, i]) => { if (left > 0) { floored[i]++; left--; } });
    return floored;
  };

  let cents;
  if (mode === 'equal') {
    cents = distribute(splits.map(() => 1));
  } else if (mode === 'exact') {
    cents = splits.map((s) => {
      const c = toCents(s.value, 'share');
      if (c < 0) bad('Shares cannot be negative');
      return c;
    });
    const sum = cents.reduce((a, b) => a + b, 0);
    if (sum !== totalCents) {
      bad(`Assigned amounts add up to ${(sum / 100).toFixed(2)} but the expense is ${(totalCents / 100).toFixed(2)}`);
    }
  } else if (mode === 'percent') {
    const pct = splits.map((s) => {
      const n = Number(s.value);
      if (!Number.isFinite(n) || n < 0) bad('Percentages must be zero or more');
      return n;
    });
    const total = pct.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 100) > 0.001) bad(`Percentages add up to ${+total.toFixed(3)}%, not 100%`);
    cents = distribute(pct);
  } else if (mode === 'shares') {
    const w = splits.map((s) => {
      const n = Number(s.value);
      if (!Number.isFinite(n) || n < 0) bad('Shares must be zero or more');
      return n;
    });
    cents = distribute(w);
  } else {
    bad('Unknown split mode');
  }
  return splits.map((s, i) => ({
    personId: s.personId,
    value: mode === 'equal' ? null : Number(s.value),
    cents: cents[i],
  }));
}

function validateExpense(body, user, existing) {
  const tripId = existing ? existing.tripId : body.tripId;
  const trip = memberTrip(tripId, user);
  const description = cleanName(body.description, 'Description');
  const amountCents = toCents(body.amount);
  if (amountCents <= 0) bad('Amount must be more than zero');
  if (!trip.memberIds.includes(body.paidBy)) bad('Payer must be on this trip');
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ? body.date : new Date().toISOString().slice(0, 10);
  const category = typeof body.category === 'string' ? body.category.slice(0, 40) : 'Other';
  const splitMode = body.splitMode;
  const shares = computeShares(amountCents, splitMode, body.splits, trip);
  return {
    tripId, description, amountCents, paidBy: body.paidBy, date, category,
    splitMode, shares,
    notes: typeof body.notes === 'string' ? body.notes.slice(0, 500) : '',
  };
}

// Who may change an expense: the person who added it or the person who paid.
// (Older expenses with no recorded creator can be changed by any trip member.)
const canEditExpense = (e, user) => !e.createdBy || e.createdBy === user.id || e.paidBy === user.id;

// Balances and a minimal set of "who pays whom" transfers for a trip.
function summary(trip) {
  const exps = db.expenses.filter((e) => e.tripId === trip.id);
  const bal = {};
  const paid = {};
  const owed = {};
  for (const id of trip.memberIds) { bal[id] = 0; paid[id] = 0; owed[id] = 0; }
  let total = 0;
  for (const e of exps) {
    total += e.amountCents;
    paid[e.paidBy] = (paid[e.paidBy] || 0) + e.amountCents;
    bal[e.paidBy] = (bal[e.paidBy] || 0) + e.amountCents;
    for (const s of e.shares) {
      owed[s.personId] = (owed[s.personId] || 0) + s.cents;
      bal[s.personId] = (bal[s.personId] || 0) - s.cents;
    }
  }
  const creditors = Object.entries(bal).filter(([, v]) => v > 0).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const debtors = Object.entries(bal).filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].v, creditors[j].v);
    if (amt > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, cents: amt });
    debtors[i].v -= amt; creditors[j].v -= amt;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return {
    totalCents: total,
    people: Object.keys(bal).map((id) => ({ personId: id, paidCents: paid[id], owedCents: owed[id], balanceCents: bal[id] })),
    transfers,
  };
}

// ---------- routes ----------
// handler(body, params, ctx) — ctx = { user, res, req }. Routes need login unless { public: true }.
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, public: !!opts.public });
};

// --- Auth ---
function cleanUsername(v) {
  const u = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) bad('Username must be 3–30 characters: letters, numbers, . _ -');
  return u;
}
function cleanPassword(v) {
  if (typeof v !== 'string' || v.length < 6) bad('Password must be at least 6 characters');
  if (v.length > 200) bad('Password is too long');
  return v;
}
function startSession(ctx, person) {
  const token = createSession(person.id);
  pruneSessions();
  save();
  ctx.res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
  return { user: publicPerson(person, person) };
}

route('GET', '/api/auth/me', (_, __, { user }) => ({ user: user ? publicPerson(user, user) : null }), { public: true });

route('POST', '/api/auth/register', (b, _, ctx) => {
  const username = cleanUsername(b.username);
  const password = cleanPassword(b.password);
  const name = cleanName(b.name, 'Your name');
  const code = normalizeCode(b.inviteCode);
  if (db.people.some((p) => p.account?.username === username)) bad('That username is taken');
  const nameTaken = (exceptId) => db.people.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
  let person;
  if (code) {
    // Claim the spot a friend created for you — only with the invite code they were shown (#2).
    const buf = Buffer.from(code);
    person = db.people.find((p) => !p.account && p.inviteCode && p.inviteCode.length === code.length
      && crypto.timingSafeEqual(Buffer.from(p.inviteCode), buf));
    if (!person) bad('That invite code isn\'t valid. Check it with the friend who added you — each code works once.');
    if (nameTaken(person.id)) bad('Someone else in the group already has that name');
    person.name = name;
    delete person.inviteCode;
  } else {
    if (nameTaken()) bad('That name is already in the group. If a friend added you, enter the invite code they gave you.');
    if (db.people.length >= MAX_PEOPLE) bad(`The group is full (${MAX_PEOPLE} people). Ask someone to remove an unused name.`);
    person = { id: newId(), name };
    db.people.push(person);
  }
  person.account = { username, ...hashPassword(password) };
  return startSession(ctx, person);
}, { public: true });

route('POST', '/api/auth/login', (b, _, ctx) => {
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  const f = failures.get(username);
  if (f && f.count >= 5 && Date.now() - f.last < 60_000) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
  const person = db.people.find((p) => p.account?.username === username);
  if (!person || typeof b.password !== 'string' || !checkPassword(b.password, person.account)) {
    failures.set(username, { count: (f && Date.now() - f.last < 60_000 ? f.count : 0) + 1, last: Date.now() });
    throw new HttpError(401, 'Wrong username or password');
  }
  failures.delete(username);
  return startSession(ctx, person);
}, { public: true });

route('POST', '/api/auth/logout', (_, __, ctx) => {
  const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
  if (token && db.sessions[token]) { delete db.sessions[token]; save(); }
  ctx.res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
}, { public: true });

route('POST', '/api/auth/password', (b, _, { user }) => {
  if (typeof b.current !== 'string' || !checkPassword(b.current, user.account)) bad('Current password is wrong');
  user.account = { username: user.account.username, ...hashPassword(cleanPassword(b.next)) };
  save();
  return { ok: true };
});

// --- People ---
route('GET', '/api/people', (_, __, { user }) => db.people.map((p) => publicPerson(p, user)));
route('POST', '/api/people', (b, _, { user }) => {
  // Add a travel buddy who hasn't signed up yet. They join with the invite code shown to you.
  if (db.people.length >= MAX_PEOPLE) bad(`This app supports up to ${MAX_PEOPLE} people`);
  const name = cleanName(b.name);
  if (db.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) bad('Someone already has that name');
  const p = { id: newId(), name, addedBy: user.id, inviteCode: newInviteCode() };
  db.people.push(p); save(); return publicPerson(p, user);
});
route('PUT', '/api/people/:id', (b, { id }, { user }) => {
  const p = db.people.find((x) => x.id === id) || notFound('Person');
  if (p.account && p.id !== user.id) forbidden('Only they can rename themselves');
  if (!p.account && !canManageInvitee(p, user)) forbidden('You can only rename people you added or who are on a trip with you');
  const name = cleanName(b.name);
  if (db.people.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) bad('Someone already has that name');
  p.name = name; save(); return publicPerson(p, user);
});
route('DELETE', '/api/people/:id', (_, { id }, { user }) => {
  const idx = db.people.findIndex((x) => x.id === id);
  if (idx < 0) notFound('Person');
  if (db.people[idx].account) forbidden('People with an account can\'t be removed from the app');
  if (!canManageInvitee(db.people[idx], user)) forbidden('You can only remove people you added or who are on a trip with you');
  const used = db.expenses.some((e) => e.paidBy === id || e.shares.some((s) => s.personId === id));
  if (used) throw new HttpError(409, 'This person is part of existing expenses. Edit or delete those first.');
  db.people.splice(idx, 1);
  for (const t of db.trips) t.memberIds = t.memberIds.filter((m) => m !== id);
  save(); return { ok: true };
});

// --- Trips (you only see trips you're on) ---
function validateTrip(b, existingId) {
  const name = cleanName(b.name, 'Trip name');
  // Strict ISO 4217 code: this value is shown all over the UI, so never accept free text (#1).
  const currency = typeof b.currency === 'string' && b.currency.trim() ? b.currency.trim().toUpperCase() : 'USD';
  if (!/^[A-Z]{3}$/.test(currency) || !CURRENCIES.has(currency)) bad('Currency must be a 3-letter code such as USD, EUR, SGD or JPY');
  const memberIds = Array.isArray(b.memberIds) ? [...new Set(b.memberIds)] : [];
  if (memberIds.length === 0) bad('Add at least one person to the trip');
  for (const m of memberIds) if (!db.people.some((p) => p.id === m)) bad('Unknown person in trip');
  if (existingId) {
    const stillUsed = db.expenses.filter((e) => e.tripId === existingId)
      .some((e) => !memberIds.includes(e.paidBy) || e.shares.some((s) => !memberIds.includes(s.personId)));
    if (stillUsed) bad('You can\'t remove someone who is part of this trip\'s expenses');
  }
  return { name, currency, memberIds };
}
route('GET', '/api/trips', (_, __, { user }) => db.trips.filter((t) => t.memberIds.includes(user.id)));
route('POST', '/api/trips', (b, _, { user }) => {
  const data = validateTrip(b);
  if (!data.memberIds.includes(user.id)) data.memberIds.unshift(user.id);
  const t = { id: newId(), ...data, createdBy: user.id, createdAt: new Date().toISOString() };
  db.trips.push(t); save(); return t;
});
route('PUT', '/api/trips/:id', (b, { id }, { user }) => {
  const t = memberTrip(id, user);
  const data = validateTrip(b, id);
  if (!data.memberIds.includes(user.id)) bad('You can\'t remove yourself from a trip');
  // The creator is the only one who can delete the trip, so they must always stay on it (#3).
  if (t.createdBy && !data.memberIds.includes(t.createdBy)) {
    bad(`${db.people.find((p) => p.id === t.createdBy)?.name || 'The trip creator'} created this trip and can't be removed from it`);
  }
  Object.assign(t, data); save(); return t;
});
route('DELETE', '/api/trips/:id', (_, { id }, { user }) => {
  const t = memberTrip(id, user);
  if (t.createdBy && t.createdBy !== user.id) forbidden(`Only ${db.people.find((p) => p.id === t.createdBy)?.name || 'the trip creator'} can delete this trip`);
  db.trips = db.trips.filter((x) => x.id !== id);
  db.expenses = db.expenses.filter((e) => e.tripId !== id);
  save(); return { ok: true };
});
route('GET', '/api/trips/:id/summary', (_, { id }, { user }) => summary(memberTrip(id, user)));

// --- Expenses ---
route('GET', '/api/trips/:id/expenses', (_, { id }, { user }) => {
  memberTrip(id, user);
  return db.expenses.filter((e) => e.tripId === id)
    .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt))
    .map((e) => ({ ...e, canEdit: canEditExpense(e, user) }));
});
route('POST', '/api/expenses', (b, _, { user }) => {
  const now = new Date().toISOString();
  const e = { id: newId(), ...validateExpense(b, user), createdBy: user.id, createdAt: now, updatedAt: now };
  db.expenses.push(e); save(); return e;
});
route('PUT', '/api/expenses/:id', (b, { id }, { user }) => {
  const e = db.expenses.find((x) => x.id === id) || notFound('Expense');
  memberTrip(e.tripId, user);
  if (!canEditExpense(e, user)) forbidden('Only the person who added or paid for this expense can change it');
  Object.assign(e, validateExpense(b, user, e), { updatedBy: user.id, updatedAt: new Date().toISOString() });
  save(); return e;
});
route('DELETE', '/api/expenses/:id', (_, { id }, { user }) => {
  const e = db.expenses.find((x) => x.id === id) || notFound('Expense');
  memberTrip(e.tripId, user);
  if (!canEditExpense(e, user)) forbidden('Only the person who added or paid for this expense can delete it');
  db.expenses = db.expenses.filter((x) => x.id !== id);
  save(); return { ok: true };
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const s = token && db.sessions[token];
  if (!s || s.expires < Date.now()) return null;
  return db.people.find((p) => p.id === s.personId && p.account) || null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        // Changes must come as JSON from the app itself (blocks cross-site form posts).
        if (req.method !== 'GET' && !String(req.headers['content-type']).startsWith('application/json')) {
          throw new HttpError(415, 'Expected JSON');
        }
        const body = raw ? JSON.parse(raw) : {};
        const user = currentUser(req);
        for (const r of routes) {
          const m = r.method === req.method && url.pathname.match(r.re);
          if (m) {
            if (!r.public && !user) throw new HttpError(401, 'Please log in');
            const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
            return send(res, req.method === 'POST' ? 201 : 200, r.handler(body, params, { user, req, res }));
          }
        }
        send(res, 404, { error: 'Not found' });
      } catch (err) {
        if (err instanceof SyntaxError) return send(res, 400, { error: 'Invalid JSON' });
        if (err instanceof HttpError) return send(res, err.status, { error: err.message });
        console.error(err);
        send(res, 500, { error: 'Server error' });
      }
    });
    return;
  }
  // Static files
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Travel Splitter running at http://localhost:${PORT}`));
