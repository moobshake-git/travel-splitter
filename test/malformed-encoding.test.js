// Regression: a stray '%' in a cookie or URL used to throw URIError → 500 on every API call.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, request, signup } = require('./helpers');

before(start);
after(stop);

test("another app's malformed cookie doesn't break login or the session", async () => {
  // Browsers send localhost cookies from every port, e.g. a dev server's `progress=100%`.
  const junk = 'progress=100%; theme=%E0%A4%A';
  const u = await signup('Ana', { username: 'ana', password: 'secret123' });
  const login = await request('POST', '/api/auth/login', { body: { username: 'ana', password: 'secret123' }, cookie: junk });
  assert.equal(login.status, 201);
  const me = await request('GET', '/api/auth/me', { cookie: `${junk}; ${u.cookie}` });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, u.user.id);
});

test('a malformed id in the URL is a 404, not a 500', async () => {
  const u = await signup('Ben');
  const r = await u.get('/api/trips/%E0%A4%A/summary');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /Trip not found/);
});
