// Split math and balances. Pure functions: no access to the database.
const { distributeUnits, percentTotalOk, parseAmount, unitCents } = require('../public/shared');
const { bad } = require('./errors');

// Money amount → integer hundredths, or a 400 explaining what's wrong.
function parseCents(v, currency = 'USD', field = 'Amount') {
  const r = parseAmount(v, currency, field);
  if (r.error) bad(r.error);
  return r.cents;
}

// Turn a split request into per-person shares in cents that always sum to the total.
// mode: 'equal'   -> splits: [{personId}]
//       'exact'   -> splits: [{personId, value}]   value = amount
//       'percent' -> splits: [{personId, value}]   value = percentage
//       'shares'  -> splits: [{personId, value}]   value = weight (e.g. 2 = double share)
//
// Amounts are in the trip's currency: for currencies without decimals (JPY, …) every share is a
// whole unit. People whose share comes to 0 are left out of the result, so a zero weight
// doesn't tie them to the expense (#6).
function computeShares(totalCents, mode, splits, memberIds, currency = 'USD') {
  const unit = unitCents(currency);
  if (!Array.isArray(splits) || splits.length === 0) bad('Pick at least one person to split with');
  if (splits.some((s) => !s || typeof s !== 'object')) bad('Each split must be an object with a personId');
  const ids = splits.map((s) => s.personId);
  if (new Set(ids).size !== ids.length) bad('A person appears twice in the split');
  for (const id of ids) if (!memberIds.includes(id)) bad('Split includes someone who is not on this trip');

  const weighted = (weights) => {
    if (weights.reduce((a, b) => a + b, 0) <= 0) bad('Split weights must add up to more than zero');
    return distributeUnits(totalCents, weights, unit);
  };

  let cents;
  if (mode === 'equal') {
    cents = weighted(splits.map(() => 1));
  } else if (mode === 'exact') {
    cents = splits.map((s) => {
      if (s.value === '' || s.value == null) return 0;
      if ((typeof s.value === 'string' && s.value.trim().startsWith('-')) || s.value < 0) bad('Shares cannot be negative');
      return parseCents(s.value, currency, 'Each share');
    });
    const sum = cents.reduce((a, b) => a + b, 0);
    if (sum !== totalCents) {
      const fmt = (c) => (c / 100).toFixed(2 - Math.log10(unit));
      bad(`Assigned amounts add up to ${fmt(sum)} but the expense is ${fmt(totalCents)}`);
    }
  } else if (mode === 'percent') {
    const pct = splits.map((s) => {
      const n = Number(s.value);
      if (!Number.isFinite(n) || n < 0) bad('Percentages must be zero or more');
      return n;
    });
    const total = pct.reduce((a, b) => a + b, 0);
    if (!percentTotalOk(total)) bad(`Percentages add up to ${+total.toFixed(3)}%, not 100%`);
    cents = weighted(pct);
  } else if (mode === 'shares') {
    cents = weighted(splits.map((s) => {
      const n = Number(s.value);
      if (!Number.isFinite(n) || n < 0) bad('Shares must be zero or more');
      return n;
    }));
  } else {
    bad('Unknown split mode');
  }
  return splits.map((s, i) => ({
    personId: s.personId,
    value: mode === 'equal' ? null : Number(s.value),
    cents: cents[i],
  })).filter((s) => s.cents > 0);
}

// Balances and a set of "who pays whom" transfers for one trip's expenses.
function summary(expenses, memberIds) {
  const bal = {};
  const paid = {};
  const owed = {};
  for (const id of memberIds) { bal[id] = 0; paid[id] = 0; owed[id] = 0; }
  let total = 0;
  for (const e of expenses) {
    total += e.amountCents;
    paid[e.paidBy] = (paid[e.paidBy] || 0) + e.amountCents;
    bal[e.paidBy] = (bal[e.paidBy] || 0) + e.amountCents;
    for (const s of e.shares) {
      owed[s.personId] = (owed[s.personId] || 0) + s.cents;
      bal[s.personId] = (bal[s.personId] || 0) - s.cents;
    }
  }
  const creditors = Object.entries(bal).filter(([, v]) => v > 0).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const debtors = Object.entries(bal).filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].v, creditors[j].v);
    if (amt > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, cents: amt });
    debtors[i].v -= amt; creditors[j].v -= amt;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return {
    totalCents: total,
    people: Object.keys(bal).map((id) => ({ personId: id, paidCents: paid[id], owedCents: owed[id], balanceCents: bal[id] })),
    transfers,
  };
}

module.exports = { parseCents, computeShares, summary };
