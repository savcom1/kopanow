'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizePastDueInvoices,
  buildAgingBucketsFromInvoices,
} = require('./customerPastDueInvoices');

test('summarizePastDueInvoices sums past-due installment amounts', () => {
  const asOfMs = new Date('2026-05-11T12:00:00.000Z').getTime();
  const rows = [
    {
      loan_id: 'L1',
      borrower_id: 'B1',
      status: 'pending',
      due_date: '2026-05-01T00:00:00.000Z',
      amount_due: 1000,
    },
    {
      loan_id: 'L2',
      borrower_id: 'B2',
      status: 'pending',
      due_date: '2026-05-20T00:00:00.000Z',
      amount_due: 500,
    },
  ];
  const summary = summarizePastDueInvoices(rows, asOfMs);
  assert.equal(summary.overdue_installment_count, 1);
  assert.equal(summary.overdue_customers_count, 1);
  assert.equal(summary.overdue_loan_count, 1);
  assert.equal(summary.overdue_amount_total, 1000);
});

test('buildAgingBucketsFromInvoices splits upcoming and past-due amounts', () => {
  const asOfMs = new Date('2026-05-11T12:00:00.000Z').getTime();
  const buckets = buildAgingBucketsFromInvoices(
    [
      {
        due_date: '2026-05-20T00:00:00.000Z',
        amount_due: 500,
      },
      {
        due_date: '2026-05-01T00:00:00.000Z',
        amount_due: 1000,
      },
    ],
    asOfMs,
  );
  assert.equal(buckets.upcoming.amount, 500);
  assert.equal(buckets.days_1_30.amount, 1000);
});
