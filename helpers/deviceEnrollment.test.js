'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-service-role-key';

const {
  normalizeHardwareSerial,
  normalizeImei,
  normalizeImeiList,
  mergeStoredImeis,
} = require('./deviceEnrollment');

test('normalizeHardwareSerial uppercases and trims', () => {
  assert.equal(normalizeHardwareSerial('  ab12cd  '), 'AB12CD');
});

test('normalizeHardwareSerial rejects unknown placeholders', () => {
  assert.equal(normalizeHardwareSerial('unknown'), '');
  assert.equal(normalizeHardwareSerial('UNKNOWN_SERIAL'), '');
  assert.equal(normalizeHardwareSerial('9774d56d682e549c'), '');
});

test('normalizeHardwareSerial rejects invalid length or charset', () => {
  assert.equal(normalizeHardwareSerial('ab'), '');
  assert.equal(normalizeHardwareSerial('AB!'), '');
  assert.equal(normalizeHardwareSerial(''), '');
  assert.equal(normalizeHardwareSerial(null), '');
});

test('normalizeHardwareSerial accepts OEM-style values', () => {
  assert.equal(normalizeHardwareSerial('RF8M12ABC3'), 'RF8M12ABC3');
  assert.equal(normalizeHardwareSerial('sn-01_test'), 'SN-01_TEST');
  assert.equal(normalizeHardwareSerial('RF8M 12AB C3'), 'RF8M12ABC3');
});

test('normalizeImei keeps digits within length bounds', () => {
  assert.equal(normalizeImei('  356938035643809  '), '356938035643809');
  assert.equal(normalizeImei('123'), '');
});

test('normalizeImeiList dedupes array and primary imei', () => {
  assert.deepEqual(
    normalizeImeiList(['356938035643809', '356938035643809', 'invalid'], '356938035643810'),
    ['356938035643809', '356938035643810'],
  );
});

test('mergeStoredImeis unions incoming and stored values', () => {
  const merged = mergeStoredImeis(['356938035643809'], {
    imei: '356938035643810',
    imeis: ['356938035643810', '356938035643811'],
  });
  assert.deepEqual(merged, [
    '356938035643809',
    '356938035643810',
    '356938035643811',
  ]);
});
