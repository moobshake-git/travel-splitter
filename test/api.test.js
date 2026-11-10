// Request-level behaviour shared by every API route.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, request, signup } = require('./helpers');

before(start);
after(stop);

test('unknown API routes return 404 JSON', async () => {
  const u = await signup();
  const r = await u.get('/api/nope');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Not found' });
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('non-GET requests must be JSON (blocks cross-site form posts)', async () => {
  const r = await request('POST', '/api/auth/login', { raw: 'username=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  const none = await request('POST', '/api/auth/logout', { headers: { 'content-type': undefined } });
  assert.equal(none.status, 415);
});

test('malformed JSON returns 400', async () => {
  const r = await request('POST', '/api/auth/login', { raw: '{"username":' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Invalid JSON' });
});

test('static files are served from public/ and traversal is blocked', async () => {
  const index = await request('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const css = await request('GET', '/styles.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal((await request('GET', '/missing.txt')).status, 404);
  assert.equal((await request('GET', '/../server.js')).status, 404);
});
