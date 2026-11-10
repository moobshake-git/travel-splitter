// Login / session hardening (#5) and the password-change lockout (#14).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { start, stop, request, signup, dataFile } = require('./helpers');

before(start);
after(stop);

const login = (username, password) => request('POST', '/api/auth/login', { body: { username, password } });
const disk = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));

test('session tokens are stored hashed, never as-is', async () => {
  const u = await signup('Hash', { username: 'hashy' });
  const token = u.cookie.split('=')[1];
  const keys = Object.keys(disk().sessions);
  assert.ok(keys.length >= 1);
  assert.ok(keys.every((k) => /^sha256:[0-9a-f]{64}$/.test(k)));
  assert.ok(!fs.readFileSync(dataFile, 'utf8').includes(token), 'raw token not in data.json');
  assert.equal((await u.get('/api/trips')).status, 200, 'and the cookie still works');
});

test('each person keeps at most 10 sessions (oldest dropped)', async () => {
  const first = await signup('Many', { username: 'many', password: 'secret123' });
  for (let i = 0; i < 10; i++) assert.equal((await login('many', 'secret123')).status, 200);
  const mine = Object.values(disk().sessions).filter((s) => s.personId === first.user.id);
  assert.equal(mine.length, 10);
  assert.equal((await first.get('/api/trips')).status, 401, 'the oldest session was dropped');
});

test('malformed usernames and oversized passwords are rejected without hashing', async () => {
  assert.equal((await login('x', 'whatever')).status, 401);
  assert.equal((await login('a'.repeat(31), 'whatever')).status, 401);
  assert.equal((await login({ evil: 1 }, 'whatever')).status, 401);
  await signup('Long', { username: 'longpw', password: 'secret123' });
  assert.equal((await login('longpw', 'x'.repeat(201))).status, 401);
});

test('a lockout tells you how long to wait and the right password is refused meanwhile', async () => {
  await signup('Lock', { username: 'locky', password: 'right123' });
  for (let i = 0; i < 5; i++) assert.equal((await login('locky', 'wrong')).status, 401);
  const r = await login('locky', 'right123');
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Wait a minute/);
});

test('password change: 5 wrong guesses lock it and log that session out (#14)', async () => {
  const u = await signup('Guard', { username: 'guard', password: 'right123' });
  const other = (await login('guard', 'right123')).headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 4; i++) {
    const r = await u.post('/api/auth/password', { current: `guess${i}`, next: 'newpass1' });
    assert.equal(r.status, 400);
  }
  const r = await u.post('/api/auth/password', { current: 'guess5', next: 'newpass1' });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /logged out for safety/);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await u.get('/api/trips')).status, 401, 'that session is gone');

  // Still locked from another session, even with the right password.
  const locked = await request('POST', '/api/auth/password', { cookie: other, body: { current: 'right123', next: 'newpass1' } });
  assert.equal(locked.status, 429);
  assert.equal((await login('guard', 'right123')).status, 200, 'the password itself was never changed');
});

test('password change: a correct guess resets the counter', async () => {
  const u = await signup('Reset', { username: 'resetty', password: 'right123' });
  for (let i = 0; i < 4; i++) await u.post('/api/auth/password', { current: 'nope', next: 'newpass1' });
  assert.equal((await u.post('/api/auth/password', { current: 'right123', next: 'newpass2' })).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await u.post('/api/auth/password', { current: 'nope', next: 'newpass3' })).status, 400);
});
