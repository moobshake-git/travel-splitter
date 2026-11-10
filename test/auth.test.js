const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, request, signup } = require('./helpers');

before(start);
after(stop);

test('register creates an account, sets a session cookie, and /me returns the user', async () => {
  const r = await request('POST', '/api/auth/register', { body: { name: 'Ana', username: 'Ana', password: 'secret123' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.name, 'Ana');
  assert.equal(r.body.user.username, 'ana', 'usernames are lower-cased');
  assert.equal(r.body.user.hasAccount, true);
  assert.equal(r.body.user.salt, undefined, 'never leaks password data');
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /^ts_session=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  const me = await request('GET', '/api/auth/me', { cookie: setCookie.split(';')[0] });
  assert.equal(me.body.user.id, r.body.user.id);
});

test('/me without a session returns null', async () => {
  const r = await request('GET', '/api/auth/me');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { user: null, maxPeople: 10 });
});

test('register validates username, password and name', async () => {
  const cases = [
    [{ name: 'X', username: 'ab', password: 'secret123' }, /Username must be/],
    [{ name: 'X', username: 'bad user', password: 'secret123' }, /Username must be/],
    [{ name: 'X', username: 'okname', password: '123' }, /at least 6/],
    [{ name: 'X', username: 'okname', password: 'x'.repeat(201) }, /too long/],
    [{ name: '  ', username: 'okname', password: 'secret123' }, /Your name is required/],
    [{ name: 'x'.repeat(81), username: 'okname', password: 'secret123' }, /Your name is too long/],
  ];
  for (const [body, msg] of cases) {
    const r = await request('POST', '/api/auth/register', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, msg);
  }
});

test('register rejects a taken username and a name already in the group', async () => {
  await signup('Bea', { username: 'bea' });
  let r = await request('POST', '/api/auth/register', { body: { name: 'Other', username: 'BEA', password: 'secret123' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /username is taken/);
  r = await request('POST', '/api/auth/register', { body: { name: 'bea', username: 'bea2', password: 'secret123' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already in the group/);
});

test('login succeeds with the right password and fails with the wrong one', async () => {
  await signup('Cal', { username: 'cal', password: 'hunter22' });
  const ok = await request('POST', '/api/auth/login', { body: { username: ' CAL ', password: 'hunter22' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.username, 'cal');
  assert.match(ok.headers.get('set-cookie'), /^ts_session=/);
  const badPw = await request('POST', '/api/auth/login', { body: { username: 'cal', password: 'nope' } });
  assert.equal(badPw.status, 401);
  const noUser = await request('POST', '/api/auth/login', { body: { username: 'ghost', password: 'whatever' } });
  assert.equal(noUser.status, 401);
  assert.equal(noUser.body.error, badPw.body.error, 'same message whether or not the user exists');
});

test('five wrong passwords lock the username, even for the right password', async () => {
  await signup('Dee', { username: 'dee', password: 'correct1' });
  for (let i = 0; i < 5; i++) {
    const r = await request('POST', '/api/auth/login', { body: { username: 'dee', password: 'wrong' } });
    assert.equal(r.status, 401);
  }
  const locked = await request('POST', '/api/auth/login', { body: { username: 'dee', password: 'correct1' } });
  assert.equal(locked.status, 429);
});

test('logout ends the session', async () => {
  const u = await signup('Eve');
  assert.equal((await u.get('/api/people')).status, 200);
  const r = await u.post('/api/auth/logout');
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await u.get('/api/people')).status, 401);
  // Logging out without a session is harmless.
  assert.equal((await request('POST', '/api/auth/logout')).status, 201);
});

test('change password requires the current one and the new one works', async () => {
  const u = await signup('Fay', { username: 'fay', password: 'oldpass1' });
  let r = await u.post('/api/auth/password', { current: 'wrong', next: 'newpass1' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Current password is wrong/);
  r = await u.post('/api/auth/password', { current: 'oldpass1', next: 'short' });
  assert.equal(r.status, 400);
  r = await u.post('/api/auth/password', { current: 'oldpass1', next: 'newpass1' });
  assert.equal(r.status, 201);
  assert.equal((await request('POST', '/api/auth/login', { body: { username: 'fay', password: 'oldpass1' } })).status, 401);
  assert.equal((await request('POST', '/api/auth/login', { body: { username: 'fay', password: 'newpass1' } })).status, 201);
});

test('protected routes require a session; unknown and expired tokens are rejected', async () => {
  for (const [m, url] of [['GET', '/api/people'], ['GET', '/api/trips'], ['POST', '/api/expenses'], ['POST', '/api/auth/password']]) {
    const r = await request(m, url, { body: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${url}`);
  }
  const r = await request('GET', '/api/trips', { cookie: 'ts_session=deadbeef' });
  assert.equal(r.status, 401);
});
