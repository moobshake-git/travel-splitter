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

class DataFileError extends Error {
  constructor(message) { super(message); this.code = 'EDATAFILE'; }
}

// Only a missing file means "start fresh". Anything else (unreadable, truncated, corrupt)
// stops the server: carrying on with an empty database would overwrite the real one on the
// first save (#16).
function load() {
  let text;
  try {
    text = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return withDefaults({});
    throw new DataFileError(`Can't read ${DATA_FILE}: ${err.message}`);
  }
  let d;
  try {
    d = JSON.parse(text);
  } catch (err) {
    throw new DataFileError(
      `${DATA_FILE} is not valid JSON (${err.message}).\n` +
      'The server will not start, so your data is not overwritten. Restore it from a backup, ' +
      'or move the file aside to start with an empty database.');
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new DataFileError(`${DATA_FILE} does not contain a JSON object.`);
  return withDefaults(d);
}

function withDefaults(d) {
  const data = { people: [], trips: [], expenses: [], sessions: {}, ...d };
  // Older data: invited people had no invite code — give them one so they can still join.
  for (const p of data.people) if (!p.account && !p.inviteCode) p.inviteCode = newInviteCode();
  return data;
}

// One shared object: modules mutate its arrays/maps (and may reassign db.trips etc.).
const db = load();

// Write to a temp file, flush it to disk, then atomically rename over the real file, so a crash
// or power cut leaves either the old file or the new one, never a truncated mix (#16).
function save() {
  const tmp = DATA_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(db, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DATA_FILE);
}

const newId = () => crypto.randomUUID();

module.exports = { db, save, newId, newInviteCode, DataFileError };
