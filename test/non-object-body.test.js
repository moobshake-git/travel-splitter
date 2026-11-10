// Regression: JSON that isn't an object (or a null split entry) used to crash handlers → 500.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, request, signup } = require('./helpers');

before(start);
after(stop);

test('a JSON body that is not an object is a 400', async () => {
  for (const raw of ['null', '42', '"text"', '[1,2]', 'true']) {
    for (const url of ['/api/auth/login', '/api/auth/register']) {
      const r = await request('POST', url, { raw });
      assert.equal(r.status, 400, `${url} ${raw}`);
      assert.deepEqual(r.body, { error: 'Expected a JSON object' });
    }
  }
});

test('an empty body still counts as {} (e.g. logout)', async () => {
  assert.equal((await request('POST', '/api/auth/logout')).status, 200);
});

test('null or non-object split entries are a 400', async () => {
  const u = await signup('Ana');
  const t = (await u.post('/api/trips', { name: 'T', memberIds: [u.user.id] })).body;
  for (const bad of [null, 5, 'id']) {
    const r = await u.post('/api/expenses', { tripId: t.id, description: 'x', amount: 1, paidBy: u.user.id, splitMode: 'equal', splits: [bad] });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /Each split must be an object/);
  }
});
