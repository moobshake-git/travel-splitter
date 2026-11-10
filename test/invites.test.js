// Invite codes, invitee permissions, username privacy, currency and trip-creator rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, request, signup } = require('./helpers');

before(start);
after(stop);

let adder, stranger;
const register = (body) => request('POST', '/api/auth/register', { body: { password: 'secret123', ...body } });

test('an invitee claims their spot with the invite code, once', async () => {
  const ana = await signup('Ana');
  const zoe = (await ana.post('/api/people', { name: 'Zoe' })).body;
  const t = (await ana.post('/api/trips', { name: 'T', memberIds: [zoe.id] })).body;

  // Codes are case-insensitive and ignore spaces/dashes.
  const pretty = `${zoe.inviteCode.slice(0, 4).toLowerCase()}-${zoe.inviteCode.slice(4)}`;
  const r = await register({ name: 'Zoe Q', username: 'zoe', inviteCode: pretty });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.id, zoe.id, 'takes over the existing person, keeping their trips');
  assert.equal(r.body.user.name, 'Zoe Q');
  assert.equal(r.body.user.inviteCode, null);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const trips = (await request('GET', '/api/trips', { cookie })).body;
  assert.deepEqual(trips.map((x) => x.id), [t.id]);

  const again = await register({ name: 'Imposter', username: 'imposter', inviteCode: zoe.inviteCode });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /invite code isn't valid/);
});

test('wrong invite code, and claiming with a name someone else has, are rejected', async () => {
  const ana = await signup('Host');
  const inv = (await ana.post('/api/people', { name: 'Yan' })).body;
  let r = await register({ name: 'Yan', username: 'yan', inviteCode: 'AAAAAAAA' });
  assert.match(r.body.error, /invite code isn't valid/);
  r = await register({ name: 'Yan', username: 'yan', inviteCode: 'SHORT' });
  assert.match(r.body.error, /invite code isn't valid/);
  r = await register({ name: 'host', username: 'yan', inviteCode: inv.inviteCode });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Someone else in the group already has that name/);
  r = await register({ name: 'Yan', username: 'yan' });
  assert.match(r.body.error, /enter the invite code/, 'cannot claim an invitee by name alone');
});

test('only the adder or a trip-mate can see the code, rename or remove an invitee', async () => {
  const ana = adder = await signup('Adder');
  const ben = stranger = await signup('Stranger');
  const cal = await signup('Mate');
  const inv = (await ana.post('/api/people', { name: 'Invitee' })).body;

  const seenByBen = (await ben.get('/api/people')).body.find((p) => p.id === inv.id);
  assert.equal(seenByBen.canManage, false);
  assert.equal(seenByBen.inviteCode, null);
  assert.equal((await ben.put(`/api/people/${inv.id}`, { name: 'Hacked' })).status, 403);
  assert.equal((await ben.del(`/api/people/${inv.id}`)).status, 403);

  await cal.post('/api/trips', { name: 'Shared', memberIds: [inv.id] });
  const seenByCal = (await cal.get('/api/people')).body.find((p) => p.id === inv.id);
  assert.equal(seenByCal.canManage, true);
  assert.equal(seenByCal.inviteCode, inv.inviteCode);
  assert.equal((await cal.put(`/api/people/${inv.id}`, { name: 'Renamed' })).status, 200);
});

test("other people's usernames are never exposed", async () => {
  const ana = await signup('Private');
  const ben = await signup('Viewer');
  const people = (await ben.get('/api/people')).body;
  assert.equal(people.find((p) => p.id === ana.user.id).username, null);
  assert.equal(people.find((p) => p.id === ben.user.id).username, ben.user.username);
});

test('trip currency must be a real ISO 4217 code', async () => {
  const u = adder;
  let r = await u.post('/api/trips', { name: 'T', memberIds: [u.user.id], currency: 'jpy' });
  assert.equal(r.body.currency, 'JPY');
  for (const currency of ['<img src=x onerror=alert(1)>', 'XYZ', 'EURO']) {
    r = await u.post('/api/trips', { name: 'T', memberIds: [u.user.id], currency });
    assert.equal(r.status, 400, currency);
    assert.match(r.body.error, /3-letter code/);
  }
});

test("the trip creator can't be removed from their trip by another member", async () => {
  const owner = adder;
  const mate = stranger;
  const t = (await owner.post('/api/trips', { name: 'Keep', memberIds: [mate.user.id] })).body;
  const r = await mate.put(`/api/trips/${t.id}`, { name: 'Keep', memberIds: [mate.user.id] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Adder created this trip and can't be removed/);
});
