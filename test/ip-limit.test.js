// One address can only fail so many logins in total, across any usernames (#5).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, request, signup } = require('./helpers');

before(start);
after(stop);

test('30 failed logins from one address lock that address out', async () => {
  await signup('Target', { username: 'target', password: 'right123' });
  for (let i = 0; i < 30; i++) {
    const r = await request('POST', '/api/auth/login', { body: { username: `spray${i}`, password: 'Password1' } });
    assert.equal(r.status, 401);
  }
  const r = await request('POST', '/api/auth/login', { body: { username: 'target', password: 'right123' } });
  assert.equal(r.status, 429);
});
