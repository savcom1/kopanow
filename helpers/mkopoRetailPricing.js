'use strict';

const MAX_LOAN_FACTOR = 0.05;
const FIRST_LOAN_FACTOR = 0.4;

function roundToNearest1000(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v / 1000) * 1000;
}

/**
 * Compute derived MKOPO amounts from a retail price converted to TZS.
 *
 * Formula:
 * - max_loan_tzs   = retail_tzs * 0.05
 * - first_loan_tzs = max_loan_tzs * 0.4
 *
 * @param {{ retail_price_amount: number|string, fx_rate_to_tzs: number|string }} args
 * @returns {{
 *   ok: true,
 *   retail_price_tzs: number,
 *   mkopo_max_loan_tzs: number,
 *   mkopo_first_loan_tzs: number
 * } | { ok: false, error: string }}
 */
function computeMkopoFromRetailPrice(args) {
  const amount = Number(args?.retail_price_amount);
  const fx = Number(args?.fx_rate_to_tzs);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'invalid_retail_price_amount' };
  if (!Number.isFinite(fx) || fx <= 0) return { ok: false, error: 'invalid_fx_rate_to_tzs' };

  const retailTzs = amount * fx;
  const maxLoan = retailTzs * MAX_LOAN_FACTOR;
  const firstLoan = maxLoan * FIRST_LOAN_FACTOR;

  const retailRounded = roundToNearest1000(retailTzs);
  const maxRounded = roundToNearest1000(maxLoan);
  const firstRounded = roundToNearest1000(firstLoan);

  if (
    retailRounded == null ||
    maxRounded == null ||
    firstRounded == null ||
    retailRounded <= 0 ||
    maxRounded <= 0 ||
    firstRounded <= 0
  ) {
    return { ok: false, error: 'non_finite_computation' };
  }

  return {
    ok: true,
    retail_price_tzs: retailRounded,
    mkopo_max_loan_tzs: maxRounded,
    mkopo_first_loan_tzs: firstRounded,
  };
}

module.exports = {
  MAX_LOAN_FACTOR,
  FIRST_LOAN_FACTOR,
  roundToNearest1000,
  computeMkopoFromRetailPrice,
};

