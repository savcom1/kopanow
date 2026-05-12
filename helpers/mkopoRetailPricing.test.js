'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMkopoFromRetailPrice } = require('./mkopoRetailPricing');

test('computeMkopoFromRetailPrice computes derived max/first loans', () => {
  const res = computeMkopoFromRetailPrice({ retail_price_amount: 1_000_000, fx_rate_to_tzs: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.retail_price_tzs, 1_000_000);
  // max = 5% of retail = 50,000
  assert.equal(res.mkopo_max_loan_tzs, 50_000);
  // first = 40% of max = 20,000
  assert.equal(res.mkopo_first_loan_tzs, 20_000);
});

test('computeMkopoFromRetailPrice rejects invalid inputs', () => {
  assert.equal(computeMkopoFromRetailPrice({ retail_price_amount: 0, fx_rate_to_tzs: 1 }).ok, false);
  assert.equal(computeMkopoFromRetailPrice({ retail_price_amount: 100, fx_rate_to_tzs: 0 }).ok, false);
  assert.equal(computeMkopoFromRetailPrice({ retail_price_amount: 'x', fx_rate_to_tzs: 1 }).ok, false);
});

