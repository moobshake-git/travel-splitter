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

  // Number/string → integer hundredths (NaN if not a finite number).
  const toCents = (v) => Math.round(Number(v) * 100);

  // Percentages must add up to 100, give or take 0.001 (so 3 × 33.333 is fine).
  // The extra 1e-9 absorbs float error: 100 - 99.999 is 0.0010000000000048885.
  const PERCENT_TOLERANCE = 0.001;
  const percentTotalOk = (total) => Math.abs(total - 100) <= PERCENT_TOLERANCE + 1e-9;

  return { CATEGORIES, DEFAULT_CATEGORY, distribute, toCents, percentTotalOk };
});
