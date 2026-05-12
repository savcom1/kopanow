'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_UNSUPPORTED_PRINCIPAL_TZS,
  enforceUnsupportedMkopoDefault,
} = require('./mkopoUnsupportedPolicy');

test('enforceUnsupportedMkopoDefault clamps when suggestion is null and not renewal', () => {
  assert.equal(enforceUnsupportedMkopoDefault(50_000, null, false), DEFAULT_UNSUPPORTED_PRINCIPAL_TZS);
});

test('enforceUnsupportedMkopoDefault keeps principal when suggestion exists', () => {
  assert.equal(enforceUnsupportedMkopoDefault(50_000, { amountTzsRounded: 20_000 }, false), 50_000);
});

test('enforceUnsupportedMkopoDefault keeps principal on renewal even if suggestion null', () => {
  assert.equal(enforceUnsupportedMkopoDefault(11_500, null, true), 11_500);
});

