// A lock file (data.json.lock, holding the server's pid) marks data.json as in use by a
// running server. The server keeps its own copy of the data in memory and rewrites the whole
// file on every change, so anything else editing data.json meanwhile would be ignored and
// then overwritten (#17). Tools that edit the file check the lock first.
const fs = require('fs');
const { DATA_FILE } = require('./config');

const LOCK_FILE = DATA_FILE + '.lock';

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// pid of the live server holding the lock, or null. Stale locks (crashed server) don't count.
function lockHolder() {
  let pid;
  try { pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()); } catch { return null; }
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
}

function acquire() {
  const holder = lockHolder();
  if (holder) return holder;
  fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
  const release = () => {
    try { if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
  return null;
}

module.exports = { LOCK_FILE, lockHolder, acquire };
