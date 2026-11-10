// Passwords, sessions, cookies and login lockout.
const crypto = require('crypto');
const { db } = require('./db');
const { SESSION_DAYS, DAY_MS, COOKIE } = require('./config');

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
  db.sessions[token] = { personId, expires: Date.now() + SESSION_DAYS * DAY_MS };
  return token;
}
function pruneSessions() {
  const now = Date.now();
  for (const [t, s] of Object.entries(db.sessions)) if (s.expires < now) delete db.sessions[t];
}
// Delete all of a person's sessions, optionally keeping one.
function revokeSessions(personId, keepToken) {
  for (const [t, s] of Object.entries(db.sessions)) if (s.personId === personId && t !== keepToken) delete db.sessions[t];
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
  const s = token && db.sessions[token];
  if (!s || s.expires < Date.now()) return null;
  return db.people.find((p) => p.id === s.personId && p.account) || null;
}

module.exports = {
  hashPassword, checkPassword, createSession, pruneSessions, revokeSessions,
  safeDecode, sessionToken, sessionCookie, currentUser,
};
