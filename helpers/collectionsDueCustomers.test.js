'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateDueCustomerCounts,
  aggregateOverdueUnpaidBorrowerCount,
  resolveBorrowerId,
} = require('./collectionsDueCustomers');

const asOfMs = new Date('2026-05-11T12:00:00.000Z').getTime();
const confirmed = new Set(['loan-a', 'loan-b', 'loan-c', 'loan-x']);

test('resolveBorrowerId falls back to loans.borrower_id', () => {
  const map = new Map([['loan-a', 'borrower-a']]);
  assert.equal(resolveBorrowerId({ loan_id: 'loan-a' }, map), 'borrower-a');
  assert.equal(resolveBorrowerId({ loan_id: 'loan-a', borrower_id: 'borrower-on-invoice' }, map), 'borrower-on-invoice');
});

test('aggregateDueCustomerCounts excludes non-customer loans', () => {
  const counts = aggregateDueCustomerCounts({
    invoices: [
      { loan_id: 'loan-foreign', borrower_id: 'borrower-x', status: 'paid', due_date: '2026-05-10T00:00:00.000Z' },
    ],
    confirmedLoanIds: confirmed,
    borrowerByLoanId: new Map(),
    asOfMs,
  });
  assert.equal(counts.due_reached_borrower_count, 0);
  assert.equal(counts.installment_rows_considered, 0);
});

test('aggregateDueCustomerCounts classifies paid, overdue, and open due borrowers', () => {
  const borrowerByLoanId = new Map([['loan-b', 'borrower-b']]);
  const counts = aggregateDueCustomerCounts({
    invoices: [
      { loan_id: 'loan-a', borrower_id: 'borrower-paid', status: 'paid', due_date: '2026-05-10T00:00:00.000Z' },
      { loan_id: 'loan-b', status: 'overdue', due_date: '2026-05-01T00:00:00.000Z' },
      {
        loan_id: 'loan-c',
        borrower_id: 'borrower-open',
        status: 'pending',
        due_date: '2026-05-11T18:00:00.000Z',
      },
    ],
    confirmedLoanIds: confirmed,
    borrowerByLoanId,
    asOfMs,
  });

  assert.equal(counts.due_reached_borrower_count, 3);
  assert.equal(counts.paid_borrower_count, 1);
  assert.equal(counts.open_due_borrower_count, 2);
  assert.equal(counts.installment_rows_considered, 3);
});

test('aggregateDueCustomerCounts keeps open due when a borrower has paid and unpaid installments', () => {
  const counts = aggregateDueCustomerCounts({
    invoices: [
      { loan_id: 'loan-a', borrower_id: 'borrower-mix', status: 'paid', due_date: '2026-05-09T00:00:00.000Z' },
      { loan_id: 'loan-a', borrower_id: 'borrower-mix', status: 'pending', due_date: '2026-05-01T00:00:00.000Z' },
    ],
    confirmedLoanIds: confirmed,
    borrowerByLoanId: new Map(),
    asOfMs,
  });

  assert.equal(counts.due_reached_borrower_count, 1);
  assert.equal(counts.paid_borrower_count, 0);
  assert.equal(counts.open_due_borrower_count, 1);
});

test('aggregateOverdueUnpaidBorrowerCount matches unpaid-invoices past-due scope', () => {
  const counts = aggregateOverdueUnpaidBorrowerCount({
    openInvoices: [
      { loan_id: 'loan-a', borrower_id: 'borrower-overdue', status: 'overdue', due_date: '2026-05-01T00:00:00.000Z' },
      { loan_id: 'loan-b', borrower_id: 'borrower-future', status: 'pending', due_date: '2026-05-20T00:00:00.000Z' },
      { loan_id: 'loan-foreign', borrower_id: 'borrower-x', status: 'overdue', due_date: '2026-05-01T00:00:00.000Z' },
    ],
    confirmedLoanIds: confirmed,
    borrowerByLoanId: new Map(),
    asOfMs,
  });

  assert.equal(counts.overdue_borrower_count, 1);
  assert.equal(counts.overdue_installment_rows_considered, 1);
});
