'use strict';

const { invoiceIsUnpaidPastDue } = require('./customersWorkflowKpi');

function resolveBorrowerId(inv, borrowerByLoanId) {
  let bid = inv?.borrower_id != null ? String(inv.borrower_id).trim() : '';
  if (!bid && inv?.loan_id) bid = borrowerByLoanId.get(inv.loan_id) || '';
  return bid;
}

/**
 * Borrower-level counts for customer loans with installments due through the as-of cut-off.
 * `invoices` should already be limited to due_date <= cut-off and status in pending/overdue/paid.
 */
function aggregateDueCustomerCounts({ invoices, confirmedLoanIds, borrowerByLoanId, asOfMs }) {
  const confirmed =
    confirmedLoanIds instanceof Set ? confirmedLoanIds : new Set(confirmedLoanIds || []);
  const loanBorrowers = borrowerByLoanId instanceof Map ? borrowerByLoanId : new Map();

  const byBorrower = new Map();
  let installmentRowsConsidered = 0;

  for (const inv of invoices || []) {
    if (!inv?.loan_id || !confirmed.has(inv.loan_id)) continue;
    const bid = resolveBorrowerId(inv, loanBorrowers);
    if (!bid) continue;

    installmentRowsConsidered += 1;
    if (!byBorrower.has(bid)) {
      byBorrower.set(bid, { hasNonPaid: false, allPaid: true });
    }
    const agg = byBorrower.get(bid);
    const st = String(inv.status || '');
    if (st !== 'paid') {
      agg.hasNonPaid = true;
      agg.allPaid = false;
    }
  }

  let paidBorrowerCount = 0;
  let openDueBorrowerCount = 0;
  for (const agg of byBorrower.values()) {
    if (agg.allPaid) {
      paidBorrowerCount += 1;
      continue;
    }
    openDueBorrowerCount += 1;
  }

  return {
    due_reached_borrower_count: byBorrower.size,
    paid_borrower_count: paidBorrowerCount,
    open_due_borrower_count: openDueBorrowerCount,
    installment_rows_considered: installmentRowsConsidered,
  };
}

/** Same borrower scope as unpaid-invoices: open pending/overdue installments past due on customer loans. */
function aggregateOverdueUnpaidBorrowerCount({
  openInvoices,
  confirmedLoanIds,
  borrowerByLoanId,
  asOfMs,
}) {
  const confirmed =
    confirmedLoanIds instanceof Set ? confirmedLoanIds : new Set(confirmedLoanIds || []);
  const loanBorrowers = borrowerByLoanId instanceof Map ? borrowerByLoanId : new Map();
  const overdueBorrowers = new Set();
  const overdueLoanIdsByBorrower = new Map();
  let installmentRowsConsidered = 0;

  for (const inv of openInvoices || []) {
    if (!inv?.loan_id || !confirmed.has(inv.loan_id)) continue;
    if (!invoiceIsUnpaidPastDue(inv, asOfMs)) continue;
    const bid = resolveBorrowerId(inv, loanBorrowers);
    if (!bid) continue;
    installmentRowsConsidered += 1;
    overdueBorrowers.add(bid);
    if (!overdueLoanIdsByBorrower.has(bid)) overdueLoanIdsByBorrower.set(bid, new Set());
    overdueLoanIdsByBorrower.get(bid).add(inv.loan_id);
  }

  return {
    overdue_borrower_count: overdueBorrowers.size,
    overdue_installment_rows_considered: installmentRowsConsidered,
    overdue_loan_ids_by_borrower: overdueLoanIdsByBorrower,
  };
}

module.exports = {
  aggregateDueCustomerCounts,
  aggregateOverdueUnpaidBorrowerCount,
  resolveBorrowerId,
};
