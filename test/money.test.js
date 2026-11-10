// Currency minor units, exact amount parsing, zero-share rows and local dates (#6).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, currencyDigits, unitCents, localToday, distributeUnits } = require('../public/shared');
const { start, stop, signup } = require('./helpers');

test('parseAmount reads decimals exactly', () => {
  assert.deepEqual(parseAmount('12'), { cents: 1200 });
  assert.deepEqual(parseAmount(' 12.5 '), { cents: 1250 });
  assert.deepEqual(parseAmount('12.50'), { cents: 1250 });
  assert.deepEqual(parseAmount('1.10'), { cents: 110 });
  assert.deepEqual(parseAmount(0.07), { cents: 7 }, 'not 7.000000000000001');
  assert.deepEqual(parseAmount('1.500'), { cents: 150 }, 'trailing zeros are fine');
  assert.deepEqual(parseAmount('10000000000'), { cents: 1e12 });
});

test('parseAmount rejects what it cannot represent exactly', () => {
  assert.match(parseAmount('1.005').error, /at most 2 decimal places/, 'no silent rounding to 1.00');
  assert.match(parseAmount('1e3').error, /must be a number like/);
  assert.match(parseAmount(1e21).error, /must be a number like/);
  assert.match(parseAmount('-5').error, /must be a number like/);
  assert.match(parseAmount('').error, /must be a number like/);
  assert.match(parseAmount(null).error, /must be a number like/);
  assert.match(parseAmount('12,50').error, /must be a number like/);
  assert.match(parseAmount('123456789012345.67').error, /too large/);
  assert.match(parseAmount('10000000000.01').error, /too large/);
});

test('zero-decimal currencies', () => {
  assert.equal(currencyDigits('JPY'), 0);
  assert.equal(currencyDigits('USD'), 2);
  assert.equal(currencyDigits('KWD'), 2, '3-decimal currencies are kept to 2');
  assert.equal(currencyDigits('NOT-A-CODE'), 2);
  assert.equal(unitCents('JPY'), 100);
  assert.equal(unitCents('EUR'), 1);
  assert.deepEqual(parseAmount('1000', 'JPY'), { cents: 100000 });
  assert.match(parseAmount('1000.5', 'JPY').error, /JPY amounts can't have decimals/);
  assert.deepEqual(distributeUnits(100000, [1, 1, 1], 100), [33400, 33300, 33300]);
});

test('localToday uses the local calendar date', () => {
  assert.equal(localToday(new Date(2026, 0, 5, 0, 30)), '2026-01-05');
  assert.equal(localToday(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

let u, ben, jpy, usd;
before(async () => {
  await start();
  u = await signup('Ana');
  ben = await signup('Ben');
  const cleo = await signup('Cleo');
  jpy = (await u.post('/api/trips', { name: 'Tokyo', currency: 'JPY', memberIds: [ben.user.id, cleo.user.id] })).body;
  usd = (await u.post('/api/trips', { name: 'NYC', currency: 'USD', memberIds: [ben.user.id] })).body;
});
after(stop);
const everyone = () => jpy.memberIds.map((personId) => ({ personId }));
const post = (trip, extra) => u.post('/api/expenses', { tripId: trip.id, description: 'x', amount: 10, paidBy: u.user.id, splitMode: 'equal', splits: [{ personId: u.user.id }], ...extra });

test('¥1000 split three ways is ¥334 / ¥333 / ¥333, never fractions of a yen', async () => {
  const r = await post(jpy, { amount: 1000, splits: everyone() });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.shares.map((s) => s.cents), [33400, 33300, 33300]);
  const pct = await post(jpy, { amount: 1000, splitMode: 'percent', splits: jpy.memberIds.map((personId) => ({ personId, value: 100 / 3 })) });
  assert.ok(pct.body.shares.every((s) => s.cents % 100 === 0));
  const s = (await u.get(`/api/trips/${jpy.id}/summary`)).body;
  assert.ok(s.people.every((p) => p.balanceCents % 100 === 0));
  assert.ok(s.transfers.every((t) => t.cents % 100 === 0));
});

test('yen amounts and exact shares must be whole', async () => {
  let r = await post(jpy, { amount: '1000.50' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /JPY amounts can't have decimals/);
  r = await post(jpy, { amount: 1000, splitMode: 'exact', splits: [{ personId: u.user.id, value: '500.5' }, { personId: ben.user.id, value: '499.5' }] });
  assert.match(r.body.error, /JPY amounts can't have decimals/);
  r = await post(jpy, { amount: 1000, splitMode: 'exact', splits: [{ personId: u.user.id, value: 600 }, { personId: ben.user.id, value: 300 }] });
  assert.match(r.body.error, /add up to 900 but the expense is 1000/);
});

test('amount validation gaps from the issue', async () => {
  for (const [amount, re] of [['1e3', /must be a number like/], ['1.005', /at most 2 decimal places/], ['123456789012345.67', /too large/], [-5, /must be a number like/]]) {
    const r = await post(usd, { amount });
    assert.equal(r.status, 400, String(amount));
    assert.match(r.body.error, re);
  }
});

test('zero-weight people get no share row, so they can still be removed from the trip', async () => {
  const t = (await u.post('/api/trips', { name: 'Zero', memberIds: [ben.user.id] })).body;
  const r = await post(t, { amount: 9, splitMode: 'shares', splits: [{ personId: u.user.id, value: 1 }, { personId: ben.user.id, value: 0 }] });
  assert.deepEqual(r.body.shares.map((s) => s.personId), [u.user.id]);
  const exact = await post(t, { amount: 9, splitMode: 'exact', splits: [{ personId: u.user.id, value: 9 }, { personId: ben.user.id, value: '' }] });
  assert.equal(exact.status, 201);
  assert.equal(exact.body.shares.length, 1);
  const tiny = await post(t, { amount: 0.01, splits: [{ personId: u.user.id }, { personId: ben.user.id }] });
  assert.deepEqual(tiny.body.shares.map((s) => s.cents), [1], 'the person whose share rounds to 0 is left out');
  const edit = await u.put(`/api/trips/${t.id}`, { name: 'Zero', memberIds: [u.user.id], expectedUpdatedAt: t.updatedAt });
  assert.equal(edit.status, 200, 'Ben is not part of any expense');
});
