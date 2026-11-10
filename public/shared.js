// Code shared by the server (require) and the browser (<script>, as window.Shared).
// Keep it dependency-free and side-effect-free.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CATEGORIES = ['Food', 'Lodging', 'Transport', 'Activities', 'Shopping', 'Other'];
  const DEFAULT_CATEGORY = 'Other';

  // Split `total` (an integer) in proportion to `weights`, handing out the leftover units
  // largest-remainder style so the result always sums to exactly `total`.
  // All-zero weights give all zeros (callers that need to reject that check first).
  function distribute(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) return weights.map(() => 0);
    const raw = weights.map((w) => (total * w) / sum);
    const floored = raw.map(Math.floor);
    let left = total - floored.reduce((a, b) => a + b, 0);
    raw.map((r, i) => [r - floored[i], i])
      .sort((a, b) => b[0] - a[0])
      .forEach(([, i]) => { if (left > 0) { floored[i]++; left--; } });
    return floored;
  }

  // Number/string → integer hundredths (NaN if not a finite number). Only for previews and
  // weights; real amounts go through parseAmount.
  const toCents = (v) => Math.round(Number(v) * 100);

  // Amounts are stored in hundredths of the trip's currency. Currencies without a minor unit
  // (JPY, KRW, …) must stay whole, so their smallest step is 100 hundredths (#6). Currencies
  // with 3 decimals (KWD, BHD, …) are kept to 2.
  function currencyDigits(currency) {
    try {
      return Math.min(2, new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
    } catch {
      return 2;
    }
  }
  const unitCents = (currency) => 10 ** (2 - currencyDigits(currency));

  // Largest single amount: 10 billion. Keeps every sum well inside Number.MAX_SAFE_INTEGER.
  const MAX_AMOUNT_CENTS = 1e12;

  // Parse a money amount exactly, from its decimal digits rather than via float `n * 100`
  // (which turns 1.005 into 100.49999…). Accepts "12", "12.5", " 12.50 " or a plain number.
  // Returns { cents } or { error }.
  function parseAmount(v, currency = 'USD', field = 'Amount') {
    const digits = currencyDigits(currency);
    const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    const m = /^(\d+)(?:\.(\d*))?$/.exec(text);
    if (!m) return { error: `${field} must be a number like 12 or 12.50` };
    const frac = (m[2] || '').replace(/0+$/, '');
    if (frac.length > digits) {
      return { error: digits === 0 ? `${currency} amounts can't have decimals` : `${field} can have at most ${digits} decimal places` };
    }
    const cents = Number(m[1]) * 100 + Number((frac + '00').slice(0, 2));
    if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) return { error: `${field} is too large` };
    return { cents };
  }

  // distribute(), but in whole currency units: the total and every share are multiples of `unit`.
  const distributeUnits = (totalCents, weights, unit = 1) =>
    distribute(Math.round(totalCents / unit), weights).map((n) => n * unit);

  // Percentages must add up to 100, give or take 0.001 (so 3 × 33.333 is fine).
  // The extra 1e-9 absorbs float error: 100 - 99.999 is 0.0010000000000048885.
  const PERCENT_TOLERANCE = 0.001;
  const percentTotalOk = (total) => Math.abs(total - 100) <= PERCENT_TOLERANCE + 1e-9;

  // Today's date where the user is, as YYYY-MM-DD (not UTC: in Singapore at 07:00 UTC is still
  // yesterday) (#6).
  function localToday(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  return {
    CATEGORIES, DEFAULT_CATEGORY, MAX_AMOUNT_CENTS, distribute, distributeUnits, toCents,
    percentTotalOk, currencyDigits, unitCents, parseAmount, localToday,
  };
});
