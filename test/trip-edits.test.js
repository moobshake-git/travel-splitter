// Editing a trip must not corrupt data (#18).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, signup } = require('./helpers');

let alice, bob, carol;
before(async () => {
  await start();
  alice = await signup('Alice');
  bob = await signup('Bob');
  carol = await signup('Carol');
});
after(stop);

test('currency can change while a trip has no expenses, but not after', async () => {
  const t = (await alice.post('/api/trips', { name: 'T', currency: 'USD', memberIds: [bob.user.id] })).body;
  let r = await alice.put(`/api/trips/${t.id}`, { name: 'T', currency: 'EUR', memberIds: t.memberIds });
  assert.equal(r.status, 200);
  assert.equal(r.body.currency, 'EUR');
  await alice.post('/api/expenses', { tripId: t.id, description: 'x', amount: 12.34, paidBy: alice.user.id, splitMode: 'equal', splits: [{ personId: alice.user.id }] });
  r = await alice.put(`/api/trips/${t.id}`, { name: 'T', currency: 'JPY', memberIds: t.memberIds });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already has expenses in EUR/);
  r = await alice.put(`/api/trips/${t.id}`, { name: 'Renamed', currency: 'EUR', memberIds: t.memberIds });
  assert.equal(r.status, 200, 'other edits still work');
});

test('an edit based on an out-of-date copy is refused with 409 (repro from the issue)', async () => {
  const t = (await alice.post('/api/trips', { name: 'Stale', memberIds: [bob.user.id] })).body;
  assert.ok(t.updatedAt);
  const alicesCopy = t;

  // Bob adds Carol.
  const bobs = await bob.put(`/api/trips/${t.id}`, { name: 'Stale', memberIds: [alice.user.id, bob.user.id, carol.user.id], expectedUpdatedAt: t.updatedAt });
  assert.equal(bobs.status, 200);
  assert.notEqual(bobs.body.updatedAt, t.updatedAt);
  assert.equal(bobs.body.updatedBy, bob.user.id);

  // Alice renames from her old screen, which still shows [Alice, Bob].
  const r = await alice.put(`/api/trips/${t.id}`, { name: 'Renamed', memberIds: alicesCopy.memberIds, expectedUpdatedAt: alicesCopy.updatedAt });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Someone else changed this trip/);
  const now = (await carol.get('/api/trips')).body.find((x) => x.id === t.id);
  assert.ok(now, 'Carol is still on the trip');
  assert.equal(now.name, 'Stale');

  // Retrying from the fresh copy works.
  const ok = await alice.put(`/api/trips/${t.id}`, { name: 'Renamed', memberIds: now.memberIds, expectedUpdatedAt: now.updatedAt });
  assert.equal(ok.status, 200);
});

test('trips saved before versioning use createdAt as their version', async () => {
  const { db } = require('../lib/db');
  const t = (await alice.post('/api/trips', { name: 'Legacy', memberIds: [alice.user.id] })).body;
  delete db.trips.find((x) => x.id === t.id).updatedAt;
  assert.equal((await alice.put(`/api/trips/${t.id}`, { name: 'L2', memberIds: [alice.user.id], expectedUpdatedAt: 'nope' })).status, 409);
  assert.equal((await alice.put(`/api/trips/${t.id}`, { name: 'L2', memberIds: [alice.user.id], expectedUpdatedAt: t.createdAt })).status, 200);
});
