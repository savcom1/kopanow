'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clearMkopoCatalogCache,
  resolveMkopoForDevice,
  resolveMkopoForDeviceStrict,
  roundToNearest1000,
  suggestFromBuildEntries,
  resolveCanonicalBrands,
} = require('./mkopoResolve');

test('roundToNearest1000', () => {
  assert.equal(roundToNearest1000(20500), 21000);
  assert.equal(roundToNearest1000(20000), 20000);
});

test('resolveCanonicalBrands detects Samsung from SM-', () => {
  const b = resolveCanonicalBrands('samsung', 'samsung', 'SM-A055F');
  assert.ok(b.includes('Samsung'));
});

test('suggestFromBuildEntries matches SM-A055F pattern when catalog has entry', () => {
  clearMkopoCatalogCache();
  const { getEntries } = require('./mkopoResolve');
  const entries = getEntries();
  const s = suggestFromBuildEntries(entries, 'samsung', 'samsung', 'SM-A055F', 'a05');
  assert.ok(s);
  assert.equal(s.amountTzsRounded, 20000);
  assert.equal(s.amountMaxTzsRounded, 20000);
});

test('resolveMkopoForDevice returns suggestion for known Samsung build', () => {
  clearMkopoCatalogCache();
  const s = resolveMkopoForDevice({
    manufacturer: 'samsung',
    brand: 'samsung',
    model: 'SM-A055F',
    device: 'a05',
  });
  assert.ok(s);
  assert.equal(s.amountTzsRounded, 20000);
  assert.equal(s.amountMaxTzsRounded, 20000);
});

test('resolveMkopoForDevice returns null for nonsense OEM', () => {
  clearMkopoCatalogCache();
  const s = resolveMkopoForDevice({
    manufacturer: 'UnknownXYZ',
    brand: 'UnknownXYZ',
    model: 'ZZZ-999',
    device: 'foo',
  });
  assert.equal(s, null);
});

test('catalog SM-A175F tier 15000 max 50000', () => {
  clearMkopoCatalogCache();
  const { getEntries, suggestFromBuildEntries } = require('./mkopoResolve');
  const entries = getEntries();
  const s = suggestFromBuildEntries(entries, 'samsung', 'samsung', 'SM-A175F', 'a17');
  assert.ok(s);
  assert.equal(s.amountTzsRounded, 15000);
  assert.equal(s.amountMaxTzsRounded, 50000);
});

test('pattern-led match when OEM string has no catalog rows', () => {
  clearMkopoCatalogCache();
  const { getEntries, suggestFromBuildEntries } = require('./mkopoResolve');
  const entries = getEntries();
  const s = suggestFromBuildEntries(entries, 'Acme', 'Acme', 'X6532C', '');
  assert.ok(s);
  assert.equal(s.amountTzsRounded, 10000);
  assert.equal(s.amountMaxTzsRounded, 50000);
});

test('resolveMkopoForDeviceStrict returns null when only brand-default would match', () => {
  clearMkopoCatalogCache();
  const s = resolveMkopoForDeviceStrict({
    manufacturer: 'samsung',
    brand: 'samsung',
    model: 'SM-UNKNOWN999',
    device: 'unknown',
  });
  assert.equal(s, null);
});

test('resolveMkopoForDeviceStrict matches pattern-led SKUs', () => {
  clearMkopoCatalogCache();
  const s = resolveMkopoForDeviceStrict({
    manufacturer: 'samsung',
    brand: 'samsung',
    model: 'SM-A175F',
    device: 'a17',
  });
  assert.ok(s);
  assert.equal(s.amountTzsRounded, 15000);
  assert.equal(s.amountMaxTzsRounded, 50000);
});
