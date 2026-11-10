// Settle up: fewest payments, and recording payments (#19).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { settle, settleGreedy } = require('../lib/split');
const { start, stop, signup } = require('./helpers');

const applyAll = (bal, transfers) => {
  const b = { ...bal };
  for (const t of transfers) { b[t.from] += t.cents; b[t.to] -= t.cents; }
  return Object.values(b).every((v) => v === 0);
};

test("the issue's repro settles in 3 payments, not 4", () => {
  const bal = { A: 700, B: 300, C: -500, D: -300, E: -200 };
  const greedy = settleGreedy(Object.entries(bal).map(([id, v]) => ({ id, v })));
  assert.equal(greedy.length, 4, 'the old greedy answer');
  const t = settle(bal);
  assert.equal(t.length, 3);
  assert.ok(applyAll(bal, t));
  assert.deepEqual(t, [
    { from: 'C', to: 'A', cents: 500 },
    { from: 'D', to: 'B', cents: 300 },
    { from: 'E', to: 'A', cents: 200 },
  ]);
});

// Brute force: the true minimum, by trying every way to split people into zero-sum groups.
function bruteMin(values) {
  const vs = values.filter((v) => v !== 0);
  let best = 0;
  const go = (rest, groups) => {
    if (!rest.length) { best = Math.max(best, groups); return; }
    const [first, ...others] = rest;
    const n = others.length;
    for (let m = 0; m < 1 << n; m++) {
      const pick = others.filter((_, i) => m & (1 << i));
      if (first + pick.reduce((a, b) => a + b, 0) === 0) go(others.filter((_, i) => !(m & (1 << i))), groups + 1);
    }
  };
  go(vs, 0);
  return vs.length - best;
}

test('settle is optimal and always zeroes every balance (randomised against brute force)', () => {
  let seed = 3;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 300; i++) {
    const n = 2 + Math.floor(r() * 7);
    const vals = Array.from({ length: n - 1 }, () => (Math.floor(r() * 7) - 3) * 100);
    vals.push(-vals.reduce((a, b) => a + b, 0));
    const bal = Object.fromEntries(vals.map((v, k) => [`p${k}`, v]));
    const t = settle(bal);
    assert.ok(applyAll(bal, t), JSON.stringify(bal));
    assert.equal(t.length, bruteMin(vals), JSON.stringify(bal));
    assert.ok(t.every((x) => x.cents > 0));
  }
  assert.deepEqual(settle({ a: 0, b: 0 }), []);
});

test('10 people with every balance distinct still settles quickly', () => {
  const bal = { a: 1, b: 2, c: 4, d: 8, e: 16, f: 32, g: 64, h: 128, i: 256, j: -511 };
  const t0 = Date.now();
  const t = settle(bal);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(t.length, 9);
  assert.ok(applyAll(bal, t));
});

let ana, ben, cal, trip;
before(async () => {
  await start();
  ana = await signup('Ana');
  ben = await signup('Ben');
  cal = await signup('Cal');
  trip = (await ana.post('/api/trips', { name: 'T', memberIds: [ben.user.id, cal.user.id] })).body;
  await ana.post('/api/expenses', { tripId: trip.id, description: 'Hotel', amount: 90, paidBy: ana.user.id, splitMode: 'equal', splits: [ana, ben, cal].map((u) => ({ personId: u.user.id })) });
});
after(stop);
const summaryOf = async () => (await ana.get(`/api/trips/${trip.id}/summary`)).body;

test('recording a payment moves balances but not the trip total', async () => {
  let s = await summaryOf();
  assert.equal(s.totalCents, 9000);
  assert.equal(s.transfers.length, 2);

  const r = await ben.post('/api/settlements', { tripId: trip.id, from: ben.user.id, to: ana.user.id, amount: '30' });
  assert.equal(r.status, 201);
  assert.equal(r.body.kind, 'settlement');
  s = await summaryOf();
  assert.equal(s.totalCents, 9000, 'trip total unchanged');
  const by = Object.fromEntries(s.people.map((p) => [p.personId, p]));
  assert.equal(by[ben.user.id].balanceCents, 0);
  assert.equal(by[ben.user.id].sentCents, 3000);
  assert.equal(by[ben.user.id].paidCents, 0, 'a repayment is not spending');
  assert.equal(by[ana.user.id].receivedCents, 3000);
  assert.equal(by[ana.user.id].balanceCents, 3000);
  assert.deepEqual(s.transfers, [{ from: cal.user.id, to: ana.user.id, cents: 3000 }]);

  const list = (await ana.get(`/api/trips/${trip.id}/expenses`)).body;
  assert.equal(list.filter((e) => e.kind === 'settlement').length, 1);
});

test('payments: validation and permissions', async () => {
  const pay = (who, body) => who.post('/api/settlements', { tripId: trip.id, from: cal.user.id, to: ana.user.id, amount: 5, ...body });
  assert.equal((await pay(ben)).status, 403, 'a third person cannot record it');
  assert.match((await pay(cal, { to: cal.user.id })).body.error, /can't pay themselves/);
  assert.match((await pay(cal, { to: 'nobody' })).body.error, /must be on this trip/);
  assert.match((await pay(cal, { amount: 0 })).body.error, /more than zero/);
  assert.match((await pay(cal, { amount: '1.001' })).body.error, /decimal places/);
  const dan = await signup('Dan');
  assert.equal((await dan.post('/api/settlements', { tripId: trip.id, from: dan.user.id, to: ana.user.id, amount: 1 })).status, 403);

  // The receiver records it; either party can delete it, nobody can edit it.
  assert.match((await pay(ana, { date: '2026-02-30' })).body.error, /not a valid calendar date/);
  const r = await pay(ana, { date: '2026-03-01' });
  assert.equal(r.status, 201);
  assert.equal(r.body.date, '2026-03-01');
  const edit = await cal.put(`/api/expenses/${r.body.id}`, { description: 'x', amount: 1, paidBy: cal.user.id, splitMode: 'equal', splits: [{ personId: ana.user.id }] });
  assert.equal(edit.status, 400);
  assert.match(edit.body.error, /can't be edited/);
  assert.equal((await ben.del(`/api/expenses/${r.body.id}`)).status, 403);
  assert.equal((await cal.del(`/api/expenses/${r.body.id}`)).status, 200, 'the payer can delete it');
  const r2 = await pay(cal);
  assert.equal((await ana.del(`/api/expenses/${r2.body.id}`)).status, 200, 'so can the receiver');
});
