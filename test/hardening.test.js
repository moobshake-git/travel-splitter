// Security headers, data caps, HTTPS and the LAN opt-in (#15).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { start, stop, request, signup } = require('./helpers');
const { db } = require('../lib/db');

before(start);
after(stop);

const root = path.join(__dirname, '..');

test('every response carries the security headers', async () => {
  for (const [method, url] of [['GET', '/'], ['GET', '/app.js'], ['GET', '/nope.txt'], ['GET', '/api/auth/me'], ['POST', '/api/nope']]) {
    const r = await request(method, url, { body: method === 'GET' ? undefined : {} });
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/, url);
    assert.match(csp, /frame-ancestors 'none'/, url);
    assert.doesNotMatch(csp, /unsafe-inline/, url);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', url);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', url);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', url);
  }
});

test('the front end has no inline scripts, event handlers or styles (the CSP would block them)', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), /\sstyle=/);
});

test('trips and expenses per trip are capped', async () => {
  const u = await signup('Cap');
  const t = (await u.post('/api/trips', { name: 'T', memberIds: [u.user.id] })).body;
  const fake = (i) => ({ id: `fake${i}`, tripId: t.id, description: 'x', amountCents: 1, paidBy: u.user.id, date: '2026-01-01', category: 'Other', splitMode: 'equal', shares: [{ personId: u.user.id, value: null, cents: 1 }], notes: '' });
  const before = db.expenses.length;
  for (let i = 0; i < 2000; i++) db.expenses.push(fake(i));
  const r = await u.post('/api/expenses', { tripId: t.id, description: 'one more', amount: 1, paidBy: u.user.id, splitMode: 'equal', splits: [{ personId: u.user.id }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /up to 2000 expenses/);
  db.expenses.splice(before);

  const tripsBefore = db.trips.length;
  for (let i = db.trips.length; i < 200; i++) db.trips.push({ id: `t${i}`, name: 'x', currency: 'USD', memberIds: [] });
  const r2 = await u.post('/api/trips', { name: 'Too many', memberIds: [u.user.id] });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /up to 200 trips/);
  db.trips.splice(tripsBefore);
});

// Start `node server.js 0` with extra env; resolve with its first output lines once it's up.
function startChild(env) {
  const child = spawn(process.execPath, ['server.js', '0'], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (c) => {
      out += c;
      const m = out.match(/localhost:(\d+)/);
      if (m) setTimeout(() => resolve({ child, port: Number(m[1]), out: () => out }), 100);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
  });
}
const kill = (child) => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });

test('LAN access is opt-in, and plain-HTTP LAN mode warns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-host-'));
  try {
    let s = await startChild({ TS_DATA_FILE: path.join(dir, 'a.json') });
    assert.doesNotMatch(s.out(), /network|Warning/);
    await kill(s.child);
    s = await startChild({ TS_DATA_FILE: path.join(dir, 'b.json'), HOST: '0.0.0.0' });
    assert.match(s.out(), /others on your network/);
    assert.match(s.out(), /Warning: plain HTTP/);
    await kill(s.child);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
test('HTTPS mode serves TLS and marks the session cookie Secure', { skip: !hasOpenssl && 'openssl not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-tls-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  try {
    const s = await startChild({ TS_DATA_FILE: path.join(dir, 'data.json'), TLS_CERT: cert, TLS_KEY: key });
    assert.match(s.out(), /https:\/\/localhost/);
    const res = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: s.port, path: '/api/auth/register', method: 'POST', rejectUnauthorized: false, headers: { 'content-type': 'application/json' } }, resolve);
      req.on('error', reject);
      req.end(JSON.stringify({ name: 'Tess', username: 'tess', password: 'secret123' }));
    });
    assert.equal(res.statusCode, 201);
    assert.match(res.headers['set-cookie'][0], /; Secure$/);
    res.resume();
    await kill(s.child);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
