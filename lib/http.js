// HTTP layer: JSON API dispatch and static files.
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { PUBLIC_DIR, MAX_BODY_BYTES } = config;
const { HttpError, bad, unauthorized } = require('./errors');
const { currentUser, safeDecode } = require('./auth');
const { routes } = require('./routes');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// Sent with every response (#15). The app has no inline scripts or styles, so the CSP can be
// strict: injected markup can't run script, and no other site can frame the app (clickjacking).
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
function setSecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

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
        throw new HttpError(415, 'Expected JSON'); // the only 415, so no helper
      }
      const body = raw ? JSON.parse(raw) : {};
      // Handlers read fields off the body, so `null`, numbers, strings and arrays are all bad requests.
      if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Expected a JSON object');
      const user = currentUser(req);
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (m) {
          if (!r.public && !user) unauthorized('Please log in');
          const params = Object.fromEntries(r.keys.map((k, i) => [k, safeDecode(m[i + 1])]));
          // Handlers may be async (password hashing is).
          return Promise.resolve()
            .then(() => r.handler(body, params, { user, req, res }))
            .then((result) => send(res, r.status, result), (err) => sendError(res, err));
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      sendError(res, err);
    }
  });
}

function sendError(res, err) {
  if (err instanceof SyntaxError) return send(res, 400, { error: 'Invalid JSON' });
  if (err instanceof HttpError) return send(res, err.status, { error: err.message });
  console.error(err);
  send(res, 500, { error: 'Server error' });
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

// Request targets like `//` or `//[` get past Node's HTTP parser but make `new URL` throw.
// Uncaught, that took the whole server down for everyone (#12).
function parseUrl(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return null;
  try { return new URL(target, 'http://localhost'); } catch { return null; }
}

function handler(req, res) {
  setSecurityHeaders(res);
  const url = parseUrl(req.url);
  if (!url) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Bad request'); }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  handleStatic(req, res, url);
}

// HTTPS if a certificate is configured, plain HTTP otherwise.
function createServer() {
  if (!config.HTTPS) return http.createServer(handler);
  return require('https').createServer({ cert: fs.readFileSync(config.TLS_CERT), key: fs.readFileSync(config.TLS_KEY) }, handler);
}
const server = createServer();

module.exports = { server, handler, SECURITY_HEADERS };
