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
  // Login brute-force protection.
  LOCKOUT_FAILURES: 5,
  LOCKOUT_MS: 60_000,
  MAX_BODY_BYTES: 1e6,
};
