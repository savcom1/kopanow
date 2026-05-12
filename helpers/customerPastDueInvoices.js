'use strict';

const { invoiceIsUnpaidPastDue } = require('./customersWorkflowKpi');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function summarizePastDueInvoices(invRows, asOfMs, borrowerIdByLoanId = new Map()) {
  let amountTotal = 0;
  const borrowers = new Set();
  const loans = new Set();
  let installmentCount = 0;

  for (const row of invRows || []) {
    if (!invoiceIsUnpaidPastDue(row, asOfMs)) continue;
    installmentCount += 1;
    amountTotal += Number(row.amount_due) || 0;
    if (row.loan_id) loans.add(row.loan_id);
    const borrowerId = row.borrower_id || borrowerIdByLoanId.get(row.loan_id);
    if (borrowerId) borrowers.add(borrowerId);
  }

  return {
    overdue_installment_count: installmentCount,
    overdue_customers_count: borrowers.size,
    overdue_loan_count: loans.size,
    overdue_amount_total: round2(amountTotal),
  };
}

function buildAgingBucketsFromInvoices(invRows, asOfMs = Date.now()) {
  const dayMs = 86400000;
  const buckets = {
    upcoming: { label: 'Not yet due', amount: 0, count: 0 },
    days_1_30: { label: '1–30 days past due', amount: 0, count: 0 },
    days_31_60: { label: '31–60 days past due', amount: 0, count: 0 },
    days_61_90: { label: '61–90 days past due', amount: 0, count: 0 },
    days_90_plus: { label: '90+ days past due', amount: 0, count: 0 },
  };

  for (const inv of invRows || []) {
    const due = new Date(inv.due_date).getTime();
    const amt = Number(inv.amount_due) || 0;
    if (Number.isNaN(due) || due > asOfMs) {
      buckets.upcoming.amount += amt;
      buckets.upcoming.count += 1;
      continue;
    }
    const daysPast = Math.floor((asOfMs - due) / dayMs);
    if (daysPast <= 30) {
      buckets.days_1_30.amount += amt;
      buckets.days_1_30.count += 1;
    } else if (daysPast <= 60) {
      buckets.days_31_60.amount += amt;
      buckets.days_31_60.count += 1;
    } else if (daysPast <= 90) {
      buckets.days_61_90.amount += amt;
      buckets.days_61_90.count += 1;
    } else {
      buckets.days_90_plus.amount += amt;
      buckets.days_90_plus.count += 1;
    }
  }

  for (const bucket of Object.values(buckets)) bucket.amount = round2(bucket.amount);
  return buckets;
}

module.exports = {
  summarizePastDueInvoices,
  buildAgingBucketsFromInvoices,
};
