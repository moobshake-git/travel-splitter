// API routes. handler(body, params, ctx) — ctx = { user, req, res }.
// Routes need a logged-in user unless registered with { public: true }.
const crypto = require('crypto');
const { db, save, newId, newInviteCode } = require('./db');
const config = require('./config');
const { MAX_PEOPLE, SESSION_DAYS, DAY_MS } = config;
const { bad, unauthorized, notFound, forbidden, conflict, tooMany: tooManyError } = require('./errors');
const auth = require('./auth');
const { Limiter, waitText } = require('./limiter');
const { parseCents, computeShares, summary, isSettlement } = require('./split');
const { localToday, CATEGORIES, DEFAULT_CATEGORY } = require('../public/shared');

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

// opts.status: the success status (default 201 for POST, which mostly creates things, else 200).
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  const status = opts.status || (method === 'POST' ? 201 : 200);
  routes.push({ method, re, keys, handler, status, public: !!opts.public });
}

// ---------- validation helpers ----------
function cleanName(v, field = 'name') {
  if (typeof v !== 'string' || !v.trim()) bad(`${field} is required`);
  if (v.trim().length > 80) bad(`${field} is too long`);
  return v.trim();
}
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
// YYYY-MM-DD that is a real calendar date; missing → today. The format check alone lets
// through dates like 2026-02-31, so round-trip it.
function cleanDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return localToday();
  if (Number.isNaN(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) bad('Date is not a valid calendar date');
  return v;
}
const normalizeCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

// ---------- people ----------
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

// ---------- trips & expenses ----------
function memberTrip(tripId, user) {
  const trip = db.trips.find((t) => t.id === tripId) || notFound('Trip');
  if (!trip.memberIds.includes(user.id)) forbidden('You are not on this trip');
  return trip;
}

function validateExpense(body, user, existing) {
  const tripId = existing ? existing.tripId : body.tripId;
  const trip = memberTrip(tripId, user);
  const description = cleanName(body.description, 'Description');
  const amountCents = parseCents(body.amount, trip.currency);
  if (amountCents <= 0) bad('Amount must be more than zero');
  if (!trip.memberIds.includes(body.paidBy)) bad('Payer must be on this trip');
  const date = cleanDate(body.date);
  // One shared category list (public/shared.js). An older expense may have a category that's no
  // longer in the list: keep it if it wasn't changed.
  const category = body.category === undefined || body.category === '' ? DEFAULT_CATEGORY : body.category;
  if (!CATEGORIES.includes(category) && category !== existing?.category) bad(`Category must be one of: ${CATEGORIES.join(', ')}`);
  const splitMode = body.splitMode;
  const shares = computeShares(amountCents, splitMode, body.splits, trip.memberIds, trip.currency);
  return {
    tripId, description, amountCents, paidBy: body.paidBy, date, category,
    splitMode, shares,
    notes: typeof body.notes === 'string' ? body.notes.slice(0, 500) : '',
  };
}

// Who may change an expense: the person who added it or the person who paid.
// (Older expenses with no recorded creator can be changed by any trip member.)
// A recorded payment can also be removed by the person who received it.
const canEditExpense = (e, user) => !e.createdBy || e.createdBy === user.id || e.paidBy === user.id ||
  (isSettlement(e) && e.shares.some((s) => s.personId === user.id));

function checkExpenseRoom(tripId) {
  const count = db.expenses.filter((e) => e.tripId === tripId).length;
  if (count >= config.MAX_EXPENSES_PER_TRIP) bad(`A trip can have up to ${config.MAX_EXPENSES_PER_TRIP} expenses.`);
}

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

// ---------- auth routes ----------
const lockoutOptions = {
  maxFailures: config.LOCKOUT_FAILURES, baseLockMs: config.LOCKOUT_MS,
  maxLockMs: config.LOCKOUT_MAX_MS, forgetMs: config.LOCKOUT_FORGET_MS,
};
const loginLimiter = new Limiter(lockoutOptions);     // per username
const ipLimiter = new Limiter({ ...lockoutOptions, maxFailures: config.IP_FAILURES }); // per IP, all usernames
const passwordLimiter = new Limiter(lockoutOptions);  // per account, for "change password"
const clientIp = (req) => req.socket.remoteAddress || '?';
const tooMany = (ms) => tooManyError(`Too many attempts. Wait ${waitText(ms)} and try again.`);

function startSession(ctx, person) {
  const token = auth.createSession(person.id);
  auth.pruneSessions();
  save();
  ctx.res.setHeader('Set-Cookie', auth.sessionCookie(token, SESSION_DAYS * DAY_MS / 1000));
  return { user: publicPerson(person, person) };
}

route('GET', '/api/auth/me', (_, __, { user }) => ({ user: user ? publicPerson(user, user) : null, maxPeople: MAX_PEOPLE }), { public: true });

route('POST', '/api/auth/register', async (b, _, ctx) => {
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
  person.account = { username, ...(await auth.hashPassword(password)) };
  return startSession(ctx, person);
}, { public: true });

route('POST', '/api/auth/login', async (b, _, ctx) => {
  const wrong = () => unauthorized('Wrong username or password');
  // Only well-formed usernames reach the limiter, so junk can't fill its memory (#5).
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,30}$/.test(username) || typeof b.password !== 'string' || b.password.length > 200) wrong();
  const ip = clientIp(ctx.req);
  const wait = Math.max(loginLimiter.lockedFor(username), ipLimiter.lockedFor(ip));
  if (wait) tooMany(wait);
  const person = db.people.find((p) => p.account?.username === username);
  if (!(await auth.checkPasswordOrDummy(b.password, person?.account))) {
    loginLimiter.fail(username);
    ipLimiter.fail(ip);
    wrong();
  }
  loginLimiter.succeed(username);
  return startSession(ctx, person);
}, { public: true, status: 200 });

route('POST', '/api/auth/logout', (_, __, ctx) => {
  if (auth.endSession(auth.sessionToken(ctx.req))) save();
  ctx.res.setHeader('Set-Cookie', auth.sessionCookie('', 0));
  return { ok: true };
}, { public: true, status: 200 });

route('POST', '/api/auth/password', async (b, _, { user, req, res }) => {
  // Same lockout as login, so a stolen session can't be used to guess the password (#14).
  const wait = passwordLimiter.lockedFor(user.id);
  if (wait) tooMany(wait);
  const next = cleanPassword(b.next);
  if (typeof b.current !== 'string' || b.current.length > 200 || !(await auth.checkPassword(b.current, user.account))) {
    if (passwordLimiter.fail(user.id)) {
      // Locked out: also end this session. If it was stolen, the thief loses it; the real
      // owner just logs in again.
      auth.endSession(auth.sessionToken(req));
      save();
      res.setHeader('Set-Cookie', auth.sessionCookie('', 0));
      unauthorized('Too many wrong passwords. You have been logged out for safety.');
    }
    bad('Current password is wrong');
  }
  passwordLimiter.succeed(user.id);
  user.account = { username: user.account.username, ...(await auth.hashPassword(next)) };
  // Sign out every other device: changing your password must cut off anyone using an old session.
  auth.revokeSessions(user.id, auth.sessionToken(req));
  save();
  return { ok: true };
}, { status: 200 });

// ---------- people routes ----------
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
  if (used) conflict('This person is part of existing expenses. Edit or delete those first.');
  db.people.splice(idx, 1);
  for (const t of db.trips) t.memberIds = t.memberIds.filter((m) => m !== id);
  save(); return { ok: true };
});

// ---------- trip routes (you only see trips you're on) ----------
route('GET', '/api/trips', (_, __, { user }) => db.trips.filter((t) => t.memberIds.includes(user.id)));
route('POST', '/api/trips', (b, _, { user }) => {
  if (db.trips.length >= config.MAX_TRIPS) bad(`This app holds up to ${config.MAX_TRIPS} trips. Delete an old one first.`);
  const data = validateTrip(b);
  if (!data.memberIds.includes(user.id)) data.memberIds.unshift(user.id);
  const now = new Date().toISOString();
  const t = { id: newId(), ...data, createdBy: user.id, createdAt: now, updatedAt: now };
  db.trips.push(t); save(); return t;
});
// A trip's version for edit checks: older trips may have no updatedAt yet.
const tripVersion = (t) => t.updatedAt || t.createdAt || null;
route('PUT', '/api/trips/:id', (b, { id }, { user }) => {
  const t = memberTrip(id, user);
  // The edit form sends the whole trip, so an edit made on an out-of-date screen would quietly
  // undo other members' changes (e.g. drop someone just added). Clients send the version they
  // loaded; if it has changed since, refuse (#18).
  if (b.expectedUpdatedAt !== undefined && b.expectedUpdatedAt !== tripVersion(t)) {
    conflict('Someone else changed this trip while you were editing. Check the latest version and save again.');
  }
  const data = validateTrip(b, id);
  // Amounts are stored as plain numbers; changing the currency would relabel them, not convert them.
  if (data.currency !== t.currency && db.expenses.some((e) => e.tripId === id)) {
    bad(`This trip already has expenses in ${t.currency}. Its currency can't be changed (amounts wouldn't be converted).`);
  }
  if (!data.memberIds.includes(user.id)) bad('You can\'t remove yourself from a trip');
  // The creator is the only one who can delete the trip, so they must always stay on it (#3).
  if (t.createdBy && !data.memberIds.includes(t.createdBy)) {
    bad(`${db.people.find((p) => p.id === t.createdBy)?.name || 'The trip creator'} created this trip and can't be removed from it`);
  }
  Object.assign(t, data, { updatedAt: new Date().toISOString(), updatedBy: user.id }); save(); return t;
});
route('DELETE', '/api/trips/:id', (_, { id }, { user }) => {
  const t = memberTrip(id, user);
  if (t.createdBy && t.createdBy !== user.id) forbidden(`Only ${db.people.find((p) => p.id === t.createdBy)?.name || 'the trip creator'} can delete this trip`);
  db.trips = db.trips.filter((x) => x.id !== id);
  db.expenses = db.expenses.filter((e) => e.tripId !== id);
  save(); return { ok: true };
});
route('GET', '/api/trips/:id/summary', (_, { id }, { user }) => {
  const t = memberTrip(id, user);
  return summary(db.expenses.filter((e) => e.tripId === t.id), t.memberIds);
});

// ---------- expense routes ----------
route('GET', '/api/trips/:id/expenses', (_, { id }, { user }) => {
  memberTrip(id, user);
  return db.expenses.filter((e) => e.tripId === id)
    .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt))
    .map((e) => ({ ...e, canEdit: canEditExpense(e, user) }));
});
route('POST', '/api/expenses', (b, _, { user }) => {
  checkExpenseRoom(b.tripId);
  const now = new Date().toISOString();
  const e = { id: newId(), ...validateExpense(b, user), createdBy: user.id, createdAt: now, updatedAt: now };
  db.expenses.push(e); save(); return e;
});
route('PUT', '/api/expenses/:id', (b, { id }, { user }) => {
  const e = db.expenses.find((x) => x.id === id) || notFound('Expense');
  memberTrip(e.tripId, user);
  if (!canEditExpense(e, user)) forbidden('Only the person who added or paid for this expense can change it');
  if (isSettlement(e)) bad('A recorded payment can\'t be edited. Delete it and record the right amount instead.');
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

// Record that one member paid another back, e.g. from the "Settle up" list (#19). Stored with
// the expenses (kind: 'settlement') so it moves balances, but it isn't counted as spending.
route('POST', '/api/settlements', (b, _, { user }) => {
  const trip = memberTrip(b.tripId, user);
  if (!trip.memberIds.includes(b.from) || !trip.memberIds.includes(b.to)) bad('Both people must be on this trip');
  if (b.from === b.to) bad('Someone can\'t pay themselves');
  if (user.id !== b.from && user.id !== b.to) forbidden('Only the person paying or the person being paid can record a payment');
  const amountCents = parseCents(b.amount, trip.currency);
  if (amountCents <= 0) bad('Amount must be more than zero');
  const date = cleanDate(b.date);
  checkExpenseRoom(trip.id);
  const now = new Date().toISOString();
  const e = {
    id: newId(), kind: 'settlement', tripId: trip.id, description: 'Payment', amountCents,
    paidBy: b.from, date, category: 'Payment', splitMode: 'exact',
    shares: [{ personId: b.to, value: null, cents: amountCents }],
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 500) : '',
    createdBy: user.id, createdAt: now, updatedAt: now,
  };
  db.expenses.push(e); save(); return e;
});

module.exports = { routes };
