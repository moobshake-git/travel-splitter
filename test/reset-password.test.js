// The reset-password CLI and the running server must not fight over data.json (#17).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');

function startServer(env) {
  const child = spawn(process.execPath, ['server.js', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/localhost:(\d+)/);
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
const stopServer = (child) => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
const cli = (env, ...args) => spawnSync(process.execPath, ['server.js', 'reset-password', ...args], { cwd: root, env, encoding: 'utf8' });
const login = (base, username, password) => fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
}).then((r) => r.status);

test('reset-password refuses to run while the server is up, and works once it stops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-reset-'));
  const env = { ...process.env, TS_DATA_FILE: path.join(dir, 'data.json') };
  try {
    let { child, base } = await startServer(env);
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ana', username: 'ana', password: 'oldpass1' }),
    });
    assert.equal(reg.status, 201);
    assert.ok(fs.existsSync(env.TS_DATA_FILE + '.lock'));

    // A second server on the same data file is refused too.
    const second = spawnSync(process.execPath, ['server.js', '0'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already using this data file/);

    const r = cli(env, 'ana', 'newpass1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /server is running/);
    assert.equal(await login(base, 'ana', 'oldpass1'), 200, 'nothing changed');

    await stopServer(child);
    assert.ok(!fs.existsSync(env.TS_DATA_FILE + '.lock'), 'lock released on shutdown');

    const ok = cli(env, 'ana', 'newpass1');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Password reset for Ana \(ana\)/);

    ({ child, base } = await startServer(env));
    assert.equal(await login(base, 'ana', 'newpass1'), 200);
    assert.equal(await login(base, 'ana', 'oldpass1'), 401);
    await stopServer(child);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a stale lock from a crashed server does not block anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-reset-'));
  const env = { ...process.env, TS_DATA_FILE: path.join(dir, 'data.json') };
  try {
    fs.writeFileSync(env.TS_DATA_FILE + '.lock', '999999999');
    const r = cli(env, 'nobody', 'newpass1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage:/, 'got past the lock check');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reset-password validates its arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-reset-'));
  const env = { ...process.env, TS_DATA_FILE: path.join(dir, 'data.json') };
  try {
    assert.match(cli(env).stderr, /Usage:/);
    assert.match(cli(env, 'ana', '123').stderr, /Usage:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
