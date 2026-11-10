const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, signup } = require('./helpers');

after(stop);

let ana, ben, cal, trip;
before(async () => {
  await start();
  ana = await signup('Ana');
  ben = await signup('Ben');
  cal = await signup('Cal');
  trip = (await ana.post('/api/trips', { name: 'Trip', memberIds: [ben.user.id, cal.user.id] })).body;
});
const everyone = () => [ana, ben, cal].map((u) => ({ personId: u.user.id }));
const add = (who, extra) => who.post('/api/expenses', {
  tripId: trip.id, description: 'Thing', amount: 10, paidBy: who.user.id, splitMode: 'equal', splits: everyone(), ...extra,
});
const cents = (e) => e.shares.map((s) => s.cents);

test('equal split hands out rounding pennies so shares sum to the total', async () => {
  const r = await add(ana, { amount: 10, date: '2026-05-01', category: 'Food', notes: 'n' });
  assert.equal(r.status, 201);
  assert.deepEqual(cents(r.body), [334, 333, 333]);
  assert.equal(r.body.amountCents, 1000);
  assert.equal(r.body.createdBy, ana.user.id);
  assert.equal(r.body.date, '2026-05-01');
  assert.equal(r.body.shares[0].value, null);
});

test('exact, percent and shares split modes', async () => {
  let r = await add(ana, { amount: 30, splitMode: 'exact', splits: [{ personId: ana.user.id, value: 10 }, { personId: ben.user.id, value: '20.00' }] });
  assert.deepEqual(cents(r.body), [1000, 2000]);
  r = await add(ana, { amount: 30, splitMode: 'exact', splits: [{ personId: ana.user.id, value: 10 }, { personId: ben.user.id, value: 10 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /add up to 20.00 but the expense is 30.00/);
  r = await add(ana, { amount: 30, splitMode: 'exact', splits: [{ personId: ana.user.id, value: 40 }, { personId: ben.user.id, value: -10 }] });
  assert.match(r.body.error, /cannot be negative/);

  r = await add(ana, { amount: 100, splitMode: 'percent', splits: [{ personId: ana.user.id, value: 33.3333 }, { personId: ben.user.id, value: 33.3333 }, { personId: cal.user.id, value: 33.3334 }] });
  assert.equal(cents(r.body).reduce((a, b) => a + b), 10000);
  r = await add(ana, { amount: 100, splitMode: 'percent', splits: [{ personId: ana.user.id, value: 50 }, { personId: ben.user.id, value: 40 }] });
  assert.match(r.body.error, /add up to 90%/);
  r = await add(ana, { amount: 100, splitMode: 'percent', splits: [{ personId: ana.user.id, value: -50 }] });
  assert.match(r.body.error, /zero or more/);

  r = await add(ana, { amount: 9, splitMode: 'shares', splits: [{ personId: ana.user.id, value: 2 }, { personId: ben.user.id, value: 1 }] });
  assert.deepEqual(cents(r.body), [600, 300]);
  r = await add(ana, { amount: 9, splitMode: 'shares', splits: [{ personId: ana.user.id, value: 0 }] });
  assert.match(r.body.error, /more than zero/);
  r = await add(ana, { amount: 9, splitMode: 'shares', splits: [{ personId: ana.user.id, value: 'x' }] });
  assert.match(r.body.error, /zero or more/);
});

test('expense validation', async () => {
  const cases = [
    [{ description: '' }, /Description is required/],
    [{ amount: 'abc' }, /amount must be a number/],
    [{ amount: 0 }, /more than zero/],
    [{ paidBy: 'nobody' }, /Payer must be on this trip/],
    [{ splits: [] }, /at least one person/],
    [{ splits: [{ personId: 'x' }] }, /not on this trip/],
    [{ splits: [{ personId: ana.user.id }, { personId: ana.user.id }] }, /appears twice/],
    [{ splitMode: 'magic' }, /Unknown split mode/],
  ];
  for (const [extra, msg] of cases) {
    const r = await add(ana, extra);
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.body.error, msg);
  }
  assert.equal((await add(ana, { tripId: 'nope' })).status, 404);
});

test('missing date defaults to today; bad category/notes fall back', async () => {
  const r = await add(ana, { date: 'yesterday', category: 5, notes: 7 });
  assert.equal(r.body.date, new Date().toISOString().slice(0, 10));
  assert.equal(r.body.category, 'Other');
  assert.equal(r.body.notes, '');
});

test('only the adder or payer can edit or delete', async () => {
  const e = (await add(ana, { paidBy: ben.user.id })).body;
  const list = (await cal.get(`/api/trips/${trip.id}/expenses`)).body;
  assert.equal(list.find((x) => x.id === e.id).canEdit, false);
  assert.equal((await cal.put(`/api/expenses/${e.id}`, { description: 'x', amount: 1, paidBy: cal.user.id, splitMode: 'equal', splits: everyone() })).status, 403);
  assert.equal((await cal.del(`/api/expenses/${e.id}`)).status, 403);

  let r = await ben.put(`/api/expenses/${e.id}`, { tripId: 'ignored', description: 'Edited', amount: 12, paidBy: ben.user.id, splitMode: 'equal', splits: everyone() });
  assert.equal(r.status, 200);
  assert.equal(r.body.description, 'Edited');
  assert.equal(r.body.tripId, trip.id, 'cannot move an expense to another trip');
  assert.equal(r.body.updatedBy, ben.user.id);
  r = await ana.del(`/api/expenses/${e.id}`);
  assert.equal(r.status, 200);
  assert.equal((await ana.del(`/api/expenses/${e.id}`)).status, 404);
  assert.equal((await ana.put(`/api/expenses/${e.id}`, {})).status, 404);
});

test('non-members cannot see or add expenses', async () => {
  const dan = await signup('Dan');
  assert.equal((await dan.get(`/api/trips/${trip.id}/expenses`)).status, 403);
  assert.equal((await add(dan)).status, 403);
});

test('expenses are listed newest date first', async () => {
  const t = (await ana.post('/api/trips', { name: 'Sorted', memberIds: [ana.user.id] })).body;
  for (const date of ['2026-01-02', '2026-03-01', '2026-02-15']) {
    await ana.post('/api/expenses', { tripId: t.id, description: date, amount: 1, paidBy: ana.user.id, splitMode: 'equal', splits: [{ personId: ana.user.id }], date });
  }
  const list = (await ana.get(`/api/trips/${t.id}/expenses`)).body;
  assert.deepEqual(list.map((e) => e.date), ['2026-03-01', '2026-02-15', '2026-01-02']);
  assert.ok(list.every((e) => e.canEdit));
});

test('summary computes balances and settle-up transfers', async () => {
  const t = (await ana.post('/api/trips', { name: 'Sum', memberIds: [ben.user.id, cal.user.id] })).body;
  const post = (who, amount) => who.post('/api/expenses', { tripId: t.id, description: 'x', amount, paidBy: who.user.id, splitMode: 'equal', splits: everyone() });
  await post(ana, 90);
  await post(ben, 30);
  const s = (await ana.get(`/api/trips/${t.id}/summary`)).body;
  assert.equal(s.totalCents, 12000);
  const by = Object.fromEntries(s.people.map((p) => [p.personId, p]));
  assert.equal(by[ana.user.id].balanceCents, 5000);
  assert.equal(by[ben.user.id].balanceCents, -1000);
  assert.equal(by[cal.user.id].balanceCents, -4000);
  assert.equal(by[ana.user.id].paidCents, 9000);
  assert.equal(by[cal.user.id].owedCents, 4000);
  assert.deepEqual(s.transfers, [
    { from: cal.user.id, to: ana.user.id, cents: 4000 },
    { from: ben.user.id, to: ana.user.id, cents: 1000 },
  ]);
});
