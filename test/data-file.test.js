// The data file: a corrupt file must never be replaced by an empty database (#16).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
function tmpData(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-data-'));
  const file = path.join(dir, 'data.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
// Load the db module in a child process so each case starts clean.
function loadDb(file, script = '') {
  return spawnSync(process.execPath, ['-e', `const m = require('./lib/db'); ${script}`], {
    cwd: root, env: { ...process.env, TS_DATA_FILE: file }, encoding: 'utf8',
  });
}

test('a truncated data.json stops the server instead of being overwritten', () => {
  const full = JSON.stringify({ people: [{ id: 'p1', name: 'Ana' }], trips: [], expenses: [], sessions: {} }, null, 2);
  const truncated = full.slice(0, 30);
  const t = tmpData(truncated);
  try {
    const r = spawnSync(process.execPath, ['server.js', '0'], { cwd: root, env: { ...process.env, TS_DATA_FILE: t.file }, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not valid JSON/);
    assert.match(r.stderr, /will not start/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), truncated, 'file left exactly as it was');
  } finally { t.cleanup(); }
});

test('a data file that is valid JSON but not an object is refused too', () => {
  const t = tmpData('[]');
  try {
    const r = loadDb(t.file);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not contain a JSON object/);
  } finally { t.cleanup(); }
});

test('an unreadable data file (e.g. a directory) is refused', () => {
  const t = tmpData();
  fs.mkdirSync(t.file);
  try {
    const r = loadDb(t.file);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Can't read/);
  } finally { t.cleanup(); }
});

test('a missing data file starts empty, and save writes a private file atomically', () => {
  const t = tmpData();
  try {
    const r = loadDb(t.file, "m.db.people.push({ id: 'x', name: 'X' }); m.save(); console.log(JSON.stringify(m.db));");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).people.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).people[0].name, 'X');
    assert.ok(!fs.existsSync(t.file + '.tmp'), 'temp file renamed away');
    if (process.platform !== 'win32') assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
  } finally { t.cleanup(); }
});

test('reset-password reports a corrupt data file without touching it', () => {
  const t = tmpData('{"people": [');
  try {
    const r = spawnSync(process.execPath, ['server.js', 'reset-password', 'ana', 'newpass1'], { cwd: root, env: { ...process.env, TS_DATA_FILE: t.file }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), '{"people": [');
  } finally { t.cleanup(); }
});
