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
  // Caps so one member can't grow data.json (rewritten on every change) without limit (#15).
  MAX_TRIPS: 200,
  MAX_EXPENSES_PER_TRIP: 2000,
  // Network: only this computer by default; HOST=0.0.0.0 opts in to LAN access (#15).
  HOST: process.env.HOST || '127.0.0.1',
  // HTTPS when both are set (paths to PEM files). Also marks the session cookie Secure.
  TLS_CERT: process.env.TLS_CERT || '',
  TLS_KEY: process.env.TLS_KEY || '',
};
module.exports.HTTPS = !!(module.exports.TLS_CERT && module.exports.TLS_KEY);
