'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeCompletedDisbursementBreakdown,
  buildLoanIdsByBorrowerFromCompletedQueueRows,
} = require('./loanoverviewDisbursementBreakdown');

test('summarizeCompletedDisbursementBreakdown: one loan per borrower has no repeats', () => {
  const rows = [
    { loan_id: 'L1', borrower_id: 'B1' },
    { loan_id: 'L2', borrower_id: 'B2' },
  ];
  const m = summarizeCompletedDisbursementBreakdown(rows);
  assert.equal(m.total_loans, 2);
  assert.equal(m.first_time_loans, 2);
  assert.equal(m.repeat_loans, 0);
  assert.equal(m.distinct_borrowers, 2);
});

test('summarizeCompletedDisbursementBreakdown: two loans same borrower counts one repeat', () => {
  const rows = [
    { loan_id: 'L1', borrower_id: 'B1' },
    { loan_id: 'L2', borrower_id: 'B1' },
  ];
  const m = summarizeCompletedDisbursementBreakdown(rows);
  assert.equal(m.total_loans, 2);
  assert.equal(m.first_time_loans, 1);
  assert.equal(m.repeat_loans, 1);
  assert.equal(m.distinct_borrowers, 1);
});

test('summarizeCompletedDisbursementBreakdown: three loans two borrowers', () => {
  const rows = [
    { loan_id: 'L1', borrower_id: 'B1' },
    { loan_id: 'L2', borrower_id: 'B1' },
    { loan_id: 'L3', borrower_id: 'B2' },
  ];
  const m = summarizeCompletedDisbursementBreakdown(rows);
  assert.equal(m.total_loans, 3);
  assert.equal(m.first_time_loans, 2);
  assert.equal(m.repeat_loans, 1);
  assert.equal(m.distinct_borrowers, 2);
});

test('summarizeCompletedDisbursementBreakdown uses loan borrower when queue borrower missing', () => {
  const rows = [{ loan_id: 'L9', borrower_id: '' }];
  const loans = new Map([['L9', { borrower_id: 'B9' }]]);
  const m = summarizeCompletedDisbursementBreakdown(rows, loans);
  assert.equal(m.total_loans, 1);
  assert.equal(m.first_time_loans, 1);
  assert.equal(m.repeat_loans, 0);
  assert.equal(m.distinct_borrowers, 1);
});

test('buildLoanIdsByBorrowerFromCompletedQueueRows groups repeat loans per borrower', () => {
  const rows = [
    { loan_id: 'L1', borrower_id: 'B1' },
    { loan_id: 'L2', borrower_id: 'B1' },
    { loan_id: 'L3', borrower_id: 'B2' },
  ];
  const byBorrower = buildLoanIdsByBorrowerFromCompletedQueueRows(rows);
  assert.deepEqual([...byBorrower.get('B1')].sort(), ['L1', 'L2']);
  assert.deepEqual([...byBorrower.get('B2')], ['L3']);
});
