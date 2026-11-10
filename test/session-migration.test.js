// Sessions saved by older versions (raw token as key) keep working after upgrading (#5).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

test('raw-token sessions are re-keyed by hash on load and still log you in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-mig-'));
  const file = path.join(dir, 'data.json');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, JSON.stringify({
    people: [{ id: 'p1', name: 'Old', account: { username: 'old', salt: 'x', hash: 'y' } }],
    trips: [], expenses: [],
    sessions: { [token]: { personId: 'p1', expires: Date.now() + 1e9 } },
  }));
  try {
    const script = `
      const { currentUser } = require('./lib/auth');
      const u = currentUser({ headers: { cookie: 'ts_session=${token}' } });
      console.log(u && u.name);`;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, TS_DATA_FILE: file }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'Old');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved.sessions), ['sha256:' + crypto.createHash('sha256').update(token).digest('hex')]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
