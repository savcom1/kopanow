'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAmountFromUmepokeaSms } = require('./umepokeaSmsAmount');

test('parses TZS with thousands separator after Umepokea', () => {
  const s =
    'Ndugu mteja, Umepokea TZS 50,000.00 kutoka JANE DOE kwenye akaunti yako.';
  assert.equal(parseAmountFromUmepokeaSms(s), 50000);
});

test('parses TSh compact form', () => {
  assert.equal(parseAmountFromUmepokeaSms('SMS: Umepokea TSh1,200.50 kutoka'), 1200.5);
});

test('parses TZS without decimals', () => {
  assert.equal(parseAmountFromUmepokeaSms('Umepokea TZS 25000. Lipa kwa simu'), 25000);
});

test('returns null without Umepokea', () => {
  assert.equal(parseAmountFromUmepokeaSms('You received TZS 5000'), null);
});

test('returns null for empty or non-string', () => {
  assert.equal(parseAmountFromUmepokeaSms(''), null);
  assert.equal(parseAmountFromUmepokeaSms(null), null);
});

test('returns null when Umepokea present but no amount', () => {
  assert.equal(parseAmountFromUmepokeaSms('Umepokea kutoka'), null);
});

test('accepts Umepokia variant spelling', () => {
  assert.equal(parseAmountFromUmepokeaSms('Umepokia TZS 3,000.00 kwa Lipa'), 3000);
});
