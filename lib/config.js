// Tunables in one place.
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

module.exports = {
  // TS_DATA_FILE lets tests point the server at a throwaway file.
  DATA_FILE: process.env.TS_DATA_FILE || path.join(__dirname, '..', 'data.json'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  MAX_PEOPLE: 10,
  SESSION_DAYS: 30,
  DAY_MS,
  COOKIE: 'ts_session',
  MAX_SESSIONS_PER_USER: 10,
  // Brute-force protection: every LOCKOUT_FAILURES wrong passwords lock the username (or the
  // account, for password changes) for LOCKOUT_MS, doubling each time up to LOCKOUT_MAX_MS.
  LOCKOUT_FAILURES: 5,
  LOCKOUT_MS: 60_000,
  LOCKOUT_MAX_MS: 60 * 60_000,
  LOCKOUT_FORGET_MS: DAY_MS,
  // Failed logins allowed per IP address (across all usernames) per lockout step.
  IP_FAILURES: 30,
  MAX_BODY_BYTES: 1e6,
};
