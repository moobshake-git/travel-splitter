// Shared test helpers: boot the real server on a random port against a throwaway data file.
// node --test runs each test file in its own process, so every file starts with an empty db.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
process.env.TS_DATA_FILE = path.join(dir, 'data.json');
const { server } = require('../server.js');

let base;
async function start() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Low-level request. `body` is JSON-encoded unless `raw` is given.
async function request(method, url, { body, raw, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (method !== 'GET' && !('content-type' in h)) h['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, body: json, text, headers: res.headers };
}

let n = 0;
// Register a fresh user and return a client bound to their session cookie.
async function signup(name = `User${++n}`, opts = {}) {
  const username = opts.username || `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}${n}`;
  const password = opts.password || 'secret123';
  const r = await request('POST', '/api/auth/register', { body: { name, username, password } });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${r.text}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return client(cookie, { ...r.body.user, password });
}
function client(cookie, user) {
  const call = (method) => (url, body, extra = {}) => request(method, url, { body, cookie, ...extra });
  return { cookie, user, get: call('GET'), post: call('POST'), put: call('PUT'), del: call('DELETE') };
}

module.exports = { start, stop, request, signup, client, dataFile: process.env.TS_DATA_FILE };
