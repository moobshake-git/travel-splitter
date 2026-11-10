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

// Fewest payments that settle every balance (#19).
//
// Any set of k people whose balances sum to zero can be settled with k − 1 payments, and no
// fewer if it contains no smaller zero-sum group. So the minimum number of payments is
// (people with a balance) − (the most zero-sum groups they can be split into). With at most
// 10 people we can find that split exactly: a DP over subsets, ~3^n steps (59,049 for n=10).
// Each group is then settled greedily (largest debtor pays largest creditor), which takes
// exactly k − 1 payments in a group with no smaller zero-sum part.
const EXACT_SETTLE_LIMIT = 15;

function settleGreedy(entries) {
  const creditors = entries.filter((e) => e.v > 0).map((e) => ({ ...e })).sort((a, b) => b.v - a.v);
  const debtors = entries.filter((e) => e.v < 0).map((e) => ({ id: e.id, v: -e.v })).sort((a, b) => b.v - a.v);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].v, creditors[j].v);
    if (amt > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, cents: amt });
    debtors[i].v -= amt; creditors[j].v -= amt;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return transfers;
}

function settle(balances) {
  const entries = Object.entries(balances).filter(([, v]) => v !== 0).map(([id, v]) => ({ id, v }));
  const n = entries.length;
  if (n === 0) return [];
  if (n > EXACT_SETTLE_LIMIT) return settleGreedy(entries);

  const full = (1 << n) - 1;
  const sum = new Array(full + 1).fill(0);
  for (let m = 1; m <= full; m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low] + entries[31 - Math.clz32(low)].v;
  }
  // groups[m] = most zero-sum groups that m can be split into (only for zero-sum m);
  // pick[m] = the group containing m's lowest member in that best split.
  const groups = new Array(full + 1).fill(-1);
  const pick = new Array(full + 1).fill(0);
  groups[0] = 0;
  for (let m = 1; m <= full; m++) {
    if (sum[m] !== 0) continue;
    const low = m & -m;
    const rest = m ^ low;
    // Every sub-group that contains `low`: low | (each subset of rest).
    for (let r = rest; ; r = (r - 1) & rest) {
      const g = low | r;
      if (sum[g] === 0 && groups[m ^ g] >= 0 && 1 + groups[m ^ g] > groups[m]) {
        groups[m] = 1 + groups[m ^ g];
        pick[m] = g;
      }
      if (r === 0) break;
    }
  }
  const transfers = [];
  for (let m = full; m; m ^= pick[m]) {
    const g = pick[m];
    transfers.push(...settleGreedy(entries.filter((_, i) => g & (1 << i))));
  }
  // Biggest payments first, for a stable, readable list.
  return transfers.sort((a, b) => b.cents - a.cents || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

// Payments between members ("Ben paid Ana back") are stored alongside expenses with
// kind: 'settlement': paidBy = who paid, a single share = who received it (#19).
const isSettlement = (e) => e.kind === 'settlement';

// Balances and the fewest "who pays whom" transfers for one trip's expenses and payments.
// Payments move balances but aren't spending, so they're left out of the total and the
// paid / share columns; they're reported per person as sent / received instead.
function summary(expenses, memberIds) {
  const bal = {};
  const paid = {};
  const owed = {};
  const sent = {};
  const received = {};
  const add = (map, id, v) => { map[id] = (map[id] || 0) + v; };
  for (const id of memberIds) { bal[id] = 0; paid[id] = 0; owed[id] = 0; sent[id] = 0; received[id] = 0; }
  let total = 0;
  for (const e of expenses) {
    add(bal, e.paidBy, e.amountCents);
    for (const s of e.shares) add(bal, s.personId, -s.cents);
    if (isSettlement(e)) {
      add(sent, e.paidBy, e.amountCents);
      for (const s of e.shares) add(received, s.personId, s.cents);
      continue;
    }
    total += e.amountCents;
    add(paid, e.paidBy, e.amountCents);
    for (const s of e.shares) add(owed, s.personId, s.cents);
  }
  return {
    totalCents: total,
    people: Object.keys(bal).map((id) => ({
      personId: id,
      paidCents: paid[id] || 0,
      owedCents: owed[id] || 0,
      sentCents: sent[id] || 0,
      receivedCents: received[id] || 0,
      balanceCents: bal[id],
    })),
    transfers: settle(bal),
  };
}

module.exports = { parseCents, computeShares, summary, settle, settleGreedy, isSettlement };
