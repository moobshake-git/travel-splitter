const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Limiter, waitText } = require('../lib/limiter');

const opts = { maxFailures: 3, baseLockMs: 1000, maxLockMs: 5000, forgetMs: 60_000 };

test('locks after maxFailures, and each lockout doubles up to the cap', () => {
  const l = new Limiter(opts);
  let t = 0;
  assert.equal(l.fail('k', t), false);
  assert.equal(l.fail('k', t), false);
  assert.equal(l.fail('k', t), true, 'third failure locks');
  assert.equal(l.lockedFor('k', t), 1000);
  t += 1000;
  assert.equal(l.lockedFor('k', t), 0);
  for (let i = 0; i < 3; i++) l.fail('k', t);
  assert.equal(l.lockedFor('k', t), 2000, 'second lockout is twice as long');
  t += 2000; for (let i = 0; i < 3; i++) l.fail('k', t);
  assert.equal(l.lockedFor('k', t), 4000);
  t += 4000; for (let i = 0; i < 3; i++) l.fail('k', t);
  assert.equal(l.lockedFor('k', t), 5000, 'capped at maxLockMs');
});

test('success clears the key; quiet keys are forgotten', () => {
  const l = new Limiter(opts);
  l.fail('a', 0); l.fail('a', 0); l.succeed('a');
  assert.equal(l.fail('a', 0), false, 'count restarted');
  for (let i = 0; i < 3; i++) l.fail('b', 0);
  assert.ok(l.lockedFor('b', 0) > 0);
  assert.equal(l.lockedFor('b', 60_001), 0);
  assert.equal(l.entries.has('b'), false);
  for (let i = 0; i < 3; i++) l.fail('c', 0);
  assert.equal(l.fail('c', 70_000), false, 'old failures no longer count');
});

test('the map is capped, dropping the least recently failed keys', () => {
  const l = new Limiter({ ...opts, maxKeys: 100 });
  for (let i = 0; i < 1000; i++) l.fail(`user${i}`, i);
  assert.equal(l.entries.size, 100);
  assert.ok(l.entries.has('user999'));
  assert.ok(!l.entries.has('user0'));
});

test('waitText', () => {
  assert.equal(waitText(1000), 'a minute');
  assert.equal(waitText(60_000), 'a minute');
  assert.equal(waitText(61_000), '2 minutes');
});
