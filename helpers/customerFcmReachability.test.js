'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyBorrowerWithoutFcmCategory,
  summarizeWithoutFcmReachability,
} = require('./customerFcmReachability');

test('classifyBorrowerWithoutFcmCategory prefers admin_removed over active missing token', () => {
  const deviceByLoanId = new Map([
    ['L1', { loan_id: 'L1', status: 'active', updated_at: '2026-05-01T00:00:00.000Z' }],
    ['L2', { loan_id: 'L2', status: 'admin_removed', updated_at: '2026-05-02T00:00:00.000Z' }],
  ]);
  const row = classifyBorrowerWithoutFcmCategory('B1', ['L1', 'L2'], deviceByLoanId, new Map());
  assert.equal(row.category, 'admin_removed');
});

test('summarizeWithoutFcmReachability buckets borrowers without FCM tokens', () => {
  const loanIdsByBorrower = new Map([
    ['B1', new Set(['L1'])],
    ['B2', new Set(['L2'])],
    ['B3', new Set(['L3'])],
  ]);
  const fcmByBorrower = new Map([
    ['B1', false],
    ['B2', false],
    ['B3', true],
  ]);
  const deviceRows = [
    { borrower_id: 'B1', loan_id: 'L1', status: 'admin_removed', updated_at: '2026-05-01T00:00:00.000Z' },
    { borrower_id: 'B2', loan_id: 'L2', status: 'active', updated_at: '2026-05-02T00:00:00.000Z' },
    { borrower_id: 'B3', loan_id: 'L3', status: 'active', fcm_token: 'tok' },
  ];
  const summary = summarizeWithoutFcmReachability({
    borrowerIds: ['B1', 'B2', 'B3'],
    loanIdsByBorrower,
    fcmByBorrower,
    deviceRows,
    loanDeviceStatusByLoanId: new Map(),
    reportLimit: 10,
  });
  assert.equal(summary.without_fcm_by_category.admin_removed, 1);
  assert.equal(summary.without_fcm_by_category.active_missing_token, 1);
  assert.equal(summary.without_fcm_report.borrower_count, 2);
  assert.equal(summary.without_fcm_report.rows[0].category, 'admin_removed');
});
