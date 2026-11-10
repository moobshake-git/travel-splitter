// Unit tests for the split math (no server needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeShares, summary } = require('../lib/split');
const { distribute } = require('../public/shared');

const members = ['a', 'b', 'c', 'd'];
const sum = (xs) => xs.reduce((x, y) => x + y, 0);
const cents = (shares) => shares.map((s) => s.cents);
const throwsMsg = (fn, re) => assert.throws(fn, (e) => e.status === 400 && re.test(e.message));

// Small deterministic PRNG so failures are reproducible.
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }

test('distribute always sums exactly to the total', () => {
  const r = rng(42);
  for (let i = 0; i < 2000; i++) {
    const total = Math.floor(r() * 1e6);
    const weights = Array.from({ length: 1 + Math.floor(r() * 10) }, () => Math.floor(r() * 5) + (r() < 0.3 ? r() : 0));
    if (sum(weights) <= 0) continue;
    const out = distribute(total, weights);
    assert.equal(sum(out), total, JSON.stringify({ total, weights }));
    assert.ok(out.every((c) => Number.isInteger(c) && c >= 0));
  }
  assert.deepEqual(distribute(100, [0, 0]), [0, 0], 'all-zero weights give zeros');
});

test('every split mode gives shares that sum to the total', () => {
  const r = rng(7);
  for (let i = 0; i < 500; i++) {
    const total = 1 + Math.floor(r() * 100000);
    const ids = members.slice(0, 1 + Math.floor(r() * members.length));
    assert.equal(sum(cents(computeShares(total, 'equal', ids.map((personId) => ({ personId })), members))), total);
    const w = ids.map((personId) => ({ personId, value: 1 + Math.floor(r() * 4) }));
    assert.equal(sum(cents(computeShares(total, 'shares', w, members))), total);
    const pct = ids.map((personId) => ({ personId, value: 100 / ids.length }));
    assert.equal(sum(cents(computeShares(total, 'percent', pct, members))), total);
  }
});

test('equal split: leftover pennies go to the first people', () => {
  assert.deepEqual(cents(computeShares(1000, 'equal', [{ personId: 'a' }, { personId: 'b' }, { personId: 'c' }], members)), [334, 333, 333]);
});

test('exact split must match the total', () => {
  const s = computeShares(1000, 'exact', [{ personId: 'a', value: '7.50' }, { personId: 'b', value: 2.5 }], members);
  assert.deepEqual(cents(s), [750, 250]);
  assert.deepEqual(s.map((x) => x.value), [7.5, 2.5]);
  throwsMsg(() => computeShares(1000, 'exact', [{ personId: 'a', value: 9.99 }], members), /add up to 9.99 but the expense is 10.00/);
  throwsMsg(() => computeShares(1000, 'exact', [{ personId: 'a', value: 'x' }], members), /Each share must be a number/);
});

test('percent: 99.999% is close enough, 99.99% is not', () => {
  const ok = computeShares(1000, 'percent', [{ personId: 'a', value: 33.333 }, { personId: 'b', value: 33.333 }, { personId: 'c', value: 33.333 }], members);
  assert.equal(sum(cents(ok)), 1000);
  throwsMsg(() => computeShares(1000, 'percent', [{ personId: 'a', value: 50 }, { personId: 'b', value: 49.99 }], members), /99.99%, not 100%/);
});

test('shares: all-zero weights are rejected', () => {
  throwsMsg(() => computeShares(1000, 'shares', [{ personId: 'a', value: 0 }, { personId: 'b', value: 0 }], members), /more than zero/);
});

test('bad split lists are rejected', () => {
  throwsMsg(() => computeShares(100, 'equal', [], members), /at least one person/);
  throwsMsg(() => computeShares(100, 'equal', 'a', members), /at least one person/);
  throwsMsg(() => computeShares(100, 'equal', [{ personId: 'a' }, { personId: 'a' }], members), /appears twice/);
  throwsMsg(() => computeShares(100, 'equal', [{ personId: 'zz' }], members), /not on this trip/);
  throwsMsg(() => computeShares(100, 'magic', [{ personId: 'a' }], members), /Unknown split mode/);
});

// Apply transfers to balances; every balance must end at zero.
function settles(s) {
  const bal = Object.fromEntries(s.people.map((p) => [p.personId, p.balanceCents]));
  for (const t of s.transfers) { bal[t.from] += t.cents; bal[t.to] -= t.cents; assert.ok(t.cents > 0); }
  return Object.values(bal).every((v) => v === 0);
}
const exp = (paidBy, amountCents, shares) => ({ paidBy, amountCents, shares: Object.entries(shares).map(([personId, c]) => ({ personId, cents: c })) });

test('summary: transfers zero out every balance', () => {
  const r = rng(99);
  for (let i = 0; i < 300; i++) {
    const expenses = Array.from({ length: 1 + Math.floor(r() * 8) }, () => {
      const total = 1 + Math.floor(r() * 50000);
      const ids = members.filter(() => r() < 0.7);
      const split = ids.length ? ids : ['a'];
      const c = distribute(total, split.map(() => 1));
      return exp(members[Math.floor(r() * members.length)], total, Object.fromEntries(split.map((id, k) => [id, c[k]])));
    });
    const s = summary(expenses, members);
    assert.ok(settles(s));
    assert.equal(sum(s.people.map((p) => p.balanceCents)), 0);
  }
});

test('summary: an all-settled trip has no transfers', () => {
  const s = summary([exp('a', 1000, { a: 500, b: 500 }), exp('b', 1000, { a: 500, b: 500 })], members);
  assert.deepEqual(s.transfers, []);
  assert.equal(s.totalCents, 2000);
});

test('summary: a payer who is not in the split is owed the whole amount', () => {
  const s = summary([exp('a', 900, { b: 450, c: 450 })], members);
  const a = s.people.find((p) => p.personId === 'a');
  assert.deepEqual([a.paidCents, a.owedCents, a.balanceCents], [900, 0, 900]);
  assert.deepEqual(s.transfers, [{ from: 'b', to: 'a', cents: 450 }, { from: 'c', to: 'a', cents: 450 }]);
});
