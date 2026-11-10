#!/usr/bin/env node
// Reset a user's password: node bin/reset-password.js <username> <new-password>
// (also available as: node server.js reset-password <username> <new-password>)
const { db, save } = require('../lib/db');
const { hashPassword, revokeSessions } = require('../lib/auth');

function resetPassword([username, password]) {
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
