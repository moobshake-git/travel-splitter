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

// Send a raw HTTP request (fetch would normalise the path).
function rawRequest(target) {
  const net = require('net');
  const { server } = require('../server.js');
  return new Promise((resolve, reject) => {
    const sock = net.connect(server.address().port, '127.0.0.1');
    let out = '';
    sock.on('data', (c) => { out += c; });
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
    sock.setTimeout(3000, () => { sock.destroy(); reject(new Error(`no response to ${target}`)); });
    sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

test('malformed request targets get a 400 and the server keeps running (#12)', async () => {
  for (const target of ['//', '//[', 'http://[', '//evil.example/api/auth/me']) {
    const out = await rawRequest(target);
    assert.match(out, /^HTTP\/1.1 400/, target);
  }
  assert.equal((await request('GET', '/api/auth/me')).status, 200, 'still serving');
});

test("only a well-formed ts_session cookie is read; others' cookies are ignored (#13)", async () => {
  const u = await signup('Cal');
  const token = u.cookie.split('=')[1];
  const r = await request('GET', '/api/auth/me', { cookie: `ts_session=%; x=%E0; ts_session=${token}` });
  assert.equal(r.body.user.id, u.user.id);
  assert.equal((await request('GET', '/api/auth/me', { cookie: `ts_session=${token.toUpperCase()}` })).body.user, null);
});
