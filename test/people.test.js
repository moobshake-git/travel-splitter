const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, signup } = require('./helpers');

after(stop);

let ana, ben;
before(async () => {
  await start(); ana = await signup('Ana'); ben = await signup('Ben'); });

test('add, list, rename and remove an invited person', async () => {
  let r = await ana.post('/api/people', { name: ' Zoe ' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['hasAccount', 'id', 'name', 'username']);
  assert.equal(r.body.hasAccount, false);
  const id = r.body.id;
  assert.ok((await ana.get('/api/people')).body.some((p) => p.id === id));
  assert.equal((await ana.post('/api/people', { name: 'zoe' })).status, 400, 'names are unique, case-insensitive');
  r = await ana.put(`/api/people/${id}`, { name: 'Zoey' });
  assert.equal(r.body.name, 'Zoey');
  assert.equal((await ana.put(`/api/people/${id}`, { name: 'ben' })).status, 400);
  r = await ana.del(`/api/people/${id}`);
  assert.equal(r.status, 200);
  assert.equal((await ana.del(`/api/people/${id}`)).status, 404);
  assert.equal((await ana.put(`/api/people/${id}`, { name: 'x' })).status, 404);
});

test('people with accounts can only rename themselves and cannot be removed', async () => {
  assert.equal((await ana.put(`/api/people/${ben.user.id}`, { name: 'Benny' })).status, 403);
  assert.equal((await ana.put(`/api/people/${ana.user.id}`, { name: 'Anna' })).body.name, 'Anna');
  assert.equal((await ana.del(`/api/people/${ben.user.id}`)).status, 403);
});

test('removing a person used in expenses is refused; otherwise they leave their trips', async () => {
  const used = (await ana.post('/api/people', { name: 'Used' })).body;
  const spare = (await ana.post('/api/people', { name: 'Spare' })).body;
  const t = (await ana.post('/api/trips', { name: 'T', memberIds: [used.id, spare.id] })).body;
  await ana.post('/api/expenses', { tripId: t.id, description: 'x', amount: 5, paidBy: ana.user.id, splitMode: 'equal', splits: [{ personId: used.id }] });
  const r = await ana.del(`/api/people/${used.id}`);
  assert.equal(r.status, 409);
  assert.equal((await ana.del(`/api/people/${spare.id}`)).status, 200);
  const trip = (await ana.get('/api/trips')).body.find((x) => x.id === t.id);
  assert.deepEqual(trip.memberIds, [ana.user.id, used.id]);
});

test('the group is capped at 10 people', async () => {
  const have = (await ana.get('/api/people')).body.length;
  for (let i = have; i < 10; i++) assert.equal((await ana.post('/api/people', { name: `Extra${i}` })).status, 201);
  const r = await ana.post('/api/people', { name: 'Eleventh' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /up to 10 people/);
});
