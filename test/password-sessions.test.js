// Regression: changing your password used to leave every other session signed in.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, request, signup } = require('./helpers');

before(start);
after(stop);

const login = async (username, password) =>
  (await request('POST', '/api/auth/login', { body: { username, password } })).headers.get('set-cookie').split(';')[0];

test("changing your password signs out your other sessions but keeps this one and other people's", async () => {
  const ana = await signup('Ana', { username: 'ana', password: 'oldpass1' });
  const ben = await signup('Ben');
  const anaPhone = await login('ana', 'oldpass1');

  const r = await ana.post('/api/auth/password', { current: 'oldpass1', next: 'newpass1' });
  assert.equal(r.status, 200);

  assert.equal((await request('GET', '/api/trips', { cookie: anaPhone })).status, 401, 'old session is revoked');
  assert.equal((await ana.get('/api/trips')).status, 200, 'the session that changed it stays signed in');
  assert.equal((await ben.get('/api/trips')).status, 200, "other people's sessions are untouched");
});

test('a failed password change revokes nothing', async () => {
  const cal = await signup('Cal', { username: 'cal', password: 'oldpass1' });
  const calPhone = await login('cal', 'oldpass1');
  assert.equal((await cal.post('/api/auth/password', { current: 'wrong', next: 'newpass1' })).status, 400);
  assert.equal((await request('GET', '/api/trips', { cookie: calPhone })).status, 200);
});
