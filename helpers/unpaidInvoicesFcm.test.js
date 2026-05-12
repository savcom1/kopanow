'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasTrimmedFcmToken, buildFcmByBorrower } = require('./unpaidInvoicesFcm');

test('hasTrimmedFcmToken treats blank values as missing', () => {
  assert.equal(hasTrimmedFcmToken(' abc '), true);
  assert.equal(hasTrimmedFcmToken(''), false);
  assert.equal(hasTrimmedFcmToken('   '), false);
  assert.equal(hasTrimmedFcmToken(null), false);
});

test('buildFcmByBorrower marks borrower from borrower_id or overdue loan_id', () => {
  const loanIdsByBorrower = new Map([
    ['b1', new Set(['loan-a'])],
    ['b2', new Set(['loan-b'])],
  ]);
  const fcm = buildFcmByBorrower(
    ['b1', 'b2'],
    loanIdsByBorrower,
    [{ borrower_id: 'b1', loan_id: 'loan-a', fcm_token: 'token-1' }],
    [{ borrower_id: null, loan_id: 'loan-b', fcm_token: ' token-2 ' }],
  );
  assert.equal(fcm.get('b1'), true);
  assert.equal(fcm.get('b2'), true);
});

test('buildFcmByBorrower leaves borrowers without tokens false', () => {
  const loanIdsByBorrower = new Map([['b1', new Set(['loan-a'])]]);
  const fcm = buildFcmByBorrower(
    ['b1'],
    loanIdsByBorrower,
    [{ borrower_id: 'b1', loan_id: 'loan-a', fcm_token: '' }],
    [],
  );
  assert.equal(fcm.get('b1'), false);
});
