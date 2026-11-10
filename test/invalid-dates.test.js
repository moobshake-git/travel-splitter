// Regression: dates in YYYY-MM-DD shape but not on the calendar (2026-02-31) were saved as-is.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, signup } = require('./helpers');

after(stop);

let u, trip;
before(async () => {
  await start();
  u = await signup('Ana');
  trip = (await u.post('/api/trips', { name: 'T', memberIds: [u.user.id] })).body;
});
const add = (date) => u.post('/api/expenses', { tripId: trip.id, description: 'x', amount: 1, paidBy: u.user.id, splitMode: 'equal', splits: [{ personId: u.user.id }], date });

test('impossible calendar dates are rejected', async () => {
  for (const date of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29', '2026-12-00']) {
    const r = await add(date);
    assert.equal(r.status, 400, date);
    assert.match(r.body.error, /not a valid calendar date/);
  }
});

test('real dates, including leap days, are accepted unchanged', async () => {
  for (const date of ['2024-02-29', '2026-12-31', '2026-01-01']) {
    const r = await add(date);
    assert.equal(r.status, 201, date);
    assert.equal(r.body.date, date);
  }
});

test('editing an expense with an impossible date is rejected too', async () => {
  const e = (await add('2026-05-01')).body;
  const r = await u.put(`/api/expenses/${e.id}`, { description: 'x', amount: 1, paidBy: u.user.id, splitMode: 'equal', splits: [{ personId: u.user.id }], date: '2026-02-30' });
  assert.equal(r.status, 400);
});
