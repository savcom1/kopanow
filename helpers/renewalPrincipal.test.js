'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRenewalPrincipalPolicy, mkopoArgsFromDeviceRow, RENEWAL_PRINCIPAL_MULTIPLIER } = require('./renewalPrincipal');

test('applyRenewalPrincipalPolicy returns null for invalid prev', () => {
  assert.equal(applyRenewalPrincipalPolicy(NaN, null), null);
  assert.equal(applyRenewalPrincipalPolicy(0, null), null);
});

test('applyRenewalPrincipalPolicy without catalog is 15% rounded', () => {
  const r = applyRenewalPrincipalPolicy(100000, null);
  assert.ok(r);
  assert.equal(r.computedBeforeClamp, 115000);
  assert.equal(r.principal, 115000);
  assert.equal(r.principal_multiplier, RENEWAL_PRINCIPAL_MULTIPLIER);
});

test('applyRenewalPrincipalPolicy clamps up to catalog min', () => {
  const mk = { amountTzsRounded: 72000, amountMaxTzsRounded: 179000, label: 'Samsung S25 Ultra' };
  const r = applyRenewalPrincipalPolicy(50000, mk);
  assert.equal(r.computedBeforeClamp, 57500);
  assert.equal(r.principal, 72000);
});

test('applyRenewalPrincipalPolicy clamps down to catalog max', () => {
  const mk = { amountTzsRounded: 47000, amountMaxTzsRounded: 117000, label: 'Samsung S25' };
  const r = applyRenewalPrincipalPolicy(102000, mk);
  assert.equal(r.computedBeforeClamp, 117300);
  assert.equal(r.principal, 117000);
});

test('mkopoArgsFromDeviceRow reads device_info and model', () => {
  const args = mkopoArgsFromDeviceRow({
    device_model: 'SM-G991B',
    device_info: { manufacturer: 'samsung', brand: 'samsung', device_model_raw: 'Galaxy S21' },
  });
  assert.equal(args.manufacturer, 'samsung');
  assert.equal(args.brand, 'samsung');
  assert.equal(args.model, 'Galaxy S21');
});
