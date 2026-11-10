// HTTP layer: JSON API dispatch and static files.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR, MAX_BODY_BYTES } = require('./config');
const { HttpError } = require('./errors');
const { currentUser, safeDecode } = require('./auth');
const { routes } = require('./routes');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function handleApi(req, res, url) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > MAX_BODY_BYTES) req.destroy(); });
  req.on('end', () => {
    try {
      // Changes must come as JSON from the app itself (blocks cross-site form posts).
      if (req.method !== 'GET' && !String(req.headers['content-type']).startsWith('application/json')) {
        throw new HttpError(415, 'Expected JSON');
      }
      const body = raw ? JSON.parse(raw) : {};
      // Handlers read fields off the body, so `null`, numbers, strings and arrays are all bad requests.
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
      const user = currentUser(req);
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (m) {
          if (!r.public && !user) throw new HttpError(401, 'Please log in');
          const params = Object.fromEntries(r.keys.map((k, i) => [k, safeDecode(m[i + 1])]));
          return send(res, req.method === 'POST' ? 201 : 200, r.handler(body, params, { user, req, res }));
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof SyntaxError) return send(res, 400, { error: 'Invalid JSON' });
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Server error' });
    }
  });
}

function handleStatic(req, res, url) {
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  handleStatic(req, res, url);
});

module.exports = { server };
