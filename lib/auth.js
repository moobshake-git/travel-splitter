// Passwords, sessions and cookies.
const crypto = require('crypto');
const { promisify } = require('util');
const { db, save } = require('./db');
const { SESSION_DAYS, DAY_MS, COOKIE, MAX_SESSIONS_PER_USER } = require('./config');

const scrypt = promisify(crypto.scrypt);

// Async so a burst of logins doesn't block the event loop for everyone (#5).
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
}
async function checkPassword(password, account) {
  const { hash } = await hashPassword(password, account.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(account.hash, 'hex'));
}
// Used for unknown usernames so they take as long as real ones (no timing hint that a user exists).
const DUMMY_ACCOUNT = { salt: '00000000000000000000000000000000', hash: '0'.repeat(128) };
async function checkPasswordOrDummy(password, account) {
  const ok = await checkPassword(password, account || DUMMY_ACCOUNT);
  return ok && !!account;
}

// Sessions are stored under a hash of the token, never the token itself, so a copy of
// data.json (e.g. a backup) can't be used to sign in as anyone (#5).
const HASH_PREFIX = 'sha256:';
const tokenKey = (token) => HASH_PREFIX + crypto.createHash('sha256').update(token).digest('hex');

// Older data stored raw tokens as keys: hash them in place so nobody gets logged out.
function migrateSessions() {
  let changed = false;
  for (const [k, s] of Object.entries(db.sessions)) {
    if (k.startsWith(HASH_PREFIX)) continue;
    delete db.sessions[k];
    db.sessions[tokenKey(k)] = s;
    changed = true;
  }
  return changed;
}

function createSession(personId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.sessions[tokenKey(token)] = { personId, created: now, expires: now + SESSION_DAYS * DAY_MS };
  // Keep only the newest few sessions per person so the file can't grow without limit.
  const mine = Object.entries(db.sessions).filter(([, s]) => s.personId === personId)
    .sort(([, a], [, b]) => (b.created || 0) - (a.created || 0));
  for (const [k] of mine.slice(MAX_SESSIONS_PER_USER)) delete db.sessions[k];
  return token;
}
function pruneSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) delete db.sessions[k];
}
// Delete all of a person's sessions, optionally keeping the one for `keepToken`.
function revokeSessions(personId, keepToken) {
  const keep = keepToken ? tokenKey(keepToken) : null;
  for (const [k, s] of Object.entries(db.sessions)) if (s.personId === personId && k !== keep) delete db.sessions[k];
}
function endSession(token) {
  const k = token && tokenKey(token);
  if (!k || !db.sessions[k]) return false;
  delete db.sessions[k];
  return true;
}

// decodeURIComponent throws on stray '%' — never let one bad value take down a request.
function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}
// Only our own cookie matters, and tokens are plain hex, so nothing is decoded. Cookies on
// localhost are shared by every port, so other apps' (possibly malformed) cookies arrive too (#13).
function sessionToken(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE && /^[0-9a-f]{64}$/.test(v || '')) return v;
  }
  return null;
}
const sessionCookie = (token, maxAgeSeconds) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;

function currentUser(req) {
  const token = sessionToken(req);
  const s = token && db.sessions[tokenKey(token)];
  if (!s || s.expires < Date.now()) return null;
  return db.people.find((p) => p.id === s.personId && p.account) || null;
}

if (migrateSessions()) save();

module.exports = {
  hashPassword, checkPassword, checkPasswordOrDummy, migrateSessions, createSession, pruneSessions,
  revokeSessions, endSession, safeDecode, sessionToken, sessionCookie, currentUser,
};
