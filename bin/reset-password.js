#!/usr/bin/env node
// Reset a user's password: node bin/reset-password.js <username> <new-password>
// (also available as: node server.js reset-password <username> <new-password>)
function resetPassword([username, password]) {
  // A running server would ignore this change and later write its old copy back (#17).
  const holder = require('../lib/lock').lockHolder();
  if (holder) {
    console.error(`The Travel Splitter server is running (pid ${holder}). Stop it, run this again, then restart it.`);
    return 1;
  }
  let db, save, hashPassword, revokeSessions;
  try {
    ({ db, save } = require('../lib/db'));
    ({ hashPassword, revokeSessions } = require('../lib/auth'));
  } catch (err) {
    if (err.code !== 'EDATAFILE') throw err;
    console.error(err.message);
    return 1;
  }
  const p = db.people.find((x) => x.account?.username === String(username).toLowerCase());
  if (!p || !password || password.length < 6) {
    console.error('Usage: node server.js reset-password <username> <new-password (6+ chars)>');
    return 1;
  }
  p.account = { username: p.account.username, ...hashPassword(password) };
  revokeSessions(p.id);
  save();
  console.log(`Password reset for ${p.name} (${p.account.username}).`);
  return 0;
}

if (require.main === module) process.exit(resetPassword(process.argv.slice(2)));
module.exports = { resetPassword };
