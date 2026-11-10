const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, signup } = require('./helpers');

after(stop);

let ana, ben, invited;
before(async () => {
  await start();
  ana = await signup('Ana');
  ben = await signup('Ben');
  invited = (await ana.post('/api/people', { name: 'Cleo' })).body;
});

test('creating a trip adds the creator and defaults the currency', async () => {
  const r = await ana.post('/api/trips', { name: '  Lisbon ', memberIds: [ben.user.id] });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Lisbon');
  assert.equal(r.body.currency, 'USD');
  assert.deepEqual(r.body.memberIds, [ana.user.id, ben.user.id]);
  assert.equal(r.body.createdBy, ana.user.id);
});

test('trip validation', async () => {
  let r = await ana.post('/api/trips', { name: '', memberIds: [ana.user.id] });
  assert.match(r.body.error, /Trip name is required/);
  r = await ana.post('/api/trips', { name: 'X', memberIds: [] });
  assert.match(r.body.error, /at least one person/);
  r = await ana.post('/api/trips', { name: 'X', memberIds: ['nobody'] });
  assert.match(r.body.error, /Unknown person/);
  r = await ana.post('/api/trips', { name: 'X', memberIds: [ana.user.id, ana.user.id], currency: ' EUR ' });
  assert.deepEqual(r.body.memberIds, [ana.user.id], 'duplicates removed');
  assert.equal(r.body.currency, 'EUR');
});

test('you only see trips you are on, and non-members get 403', async () => {
  const t = (await ana.post('/api/trips', { name: 'Solo', memberIds: [ana.user.id] })).body;
  const benTrips = (await ben.get('/api/trips')).body.map((x) => x.id);
  assert.ok(!benTrips.includes(t.id));
  assert.equal((await ben.get(`/api/trips/${t.id}/summary`)).status, 403);
  assert.equal((await ben.put(`/api/trips/${t.id}`, { name: 'Mine', memberIds: [ben.user.id] })).status, 403);
  assert.equal((await ben.del(`/api/trips/${t.id}`)).status, 403);
  assert.equal((await ben.get('/api/trips/does-not-exist/summary')).status, 404);
});

test('any member can edit a trip but cannot remove themselves', async () => {
  const t = (await ana.post('/api/trips', { name: 'Rome', memberIds: [ben.user.id] })).body;
  let r = await ben.put(`/api/trips/${t.id}`, { name: 'Roma', currency: 'EUR', memberIds: [ana.user.id, ben.user.id, invited.id] });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Roma');
  assert.equal(r.body.memberIds.length, 3);
  r = await ben.put(`/api/trips/${t.id}`, { name: 'Roma', memberIds: [ana.user.id] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /remove yourself/);
});

test('members cannot be removed while they are part of expenses', async () => {
  const t = (await ana.post('/api/trips', { name: 'Oslo', memberIds: [ben.user.id] })).body;
  await ana.post('/api/expenses', { tripId: t.id, description: 'Taxi', amount: 10, paidBy: ben.user.id, splitMode: 'equal', splits: [{ personId: ana.user.id }] });
  const r = await ana.put(`/api/trips/${t.id}`, { name: 'Oslo', memberIds: [ana.user.id] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /part of this trip's expenses/);
});

test('only the creator can delete a trip, and its expenses go with it', async () => {
  const t = (await ana.post('/api/trips', { name: 'Paris', memberIds: [ben.user.id] })).body;
  await ana.post('/api/expenses', { tripId: t.id, description: 'Wine', amount: 20, paidBy: ana.user.id, splitMode: 'equal', splits: [{ personId: ana.user.id }, { personId: ben.user.id }] });
  let r = await ben.del(`/api/trips/${t.id}`);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Only Ana can delete/);
  r = await ana.del(`/api/trips/${t.id}`);
  assert.equal(r.status, 200);
  assert.equal((await ana.get(`/api/trips/${t.id}/expenses`)).status, 404);
});
