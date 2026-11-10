// The whole database is one JSON file, loaded into memory at start and rewritten on every
// change. Synchronous whole-file writes are a deliberate choice: with at most 10 people the
// file stays small, and it keeps the code simple and the file always consistent.
const fs = require('fs');
const crypto = require('crypto');
const { DATA_FILE } = require('./config');

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I look-alikes

// 8 characters from a 32-letter alphabet = 40 bits of randomness.
function newInviteCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return s;
}

function load() {
  let d;
  try { d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { d = {}; }
  const data = { people: [], trips: [], expenses: [], sessions: {}, ...d };
  // Older data: invited people had no invite code — give them one so they can still join.
  for (const p of data.people) if (!p.account && !p.inviteCode) p.inviteCode = newInviteCode();
  return data;
}

// One shared object: modules mutate its arrays/maps (and may reassign db.trips etc.).
const db = load();

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const newId = () => crypto.randomUUID();

module.exports = { db, save, newId, newInviteCode };
