'use strict';

function trimId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function resolveBorrowerId(row, loansByLoanId = new Map()) {
  const loanId = trimId(row?.loan_id);
  return (
    trimId(row?.borrower_id) ||
    trimId(loansByLoanId instanceof Map ? loansByLoanId.get(loanId)?.borrower_id : loansByLoanId?.[loanId]?.borrower_id)
  );
}

/**
 * @param {Array<{ loan_id?: string, borrower_id?: string }>} completedQueueRows
 * @param {Map<string, { borrower_id?: string }>|Record<string, { borrower_id?: string }>} [loansByLoanId]
 */
function uniqueBorrowersFromCompletedQueueRows(completedQueueRows, loansByLoanId = new Map()) {
  const borrowers = new Set();
  for (const row of completedQueueRows || []) {
    const borrowerId = resolveBorrowerId(row, loansByLoanId);
    if (borrowerId) borrowers.add(borrowerId);
  }
  return borrowers;
}

/**
 * @param {Array<{ loan_id?: string, borrower_id?: string }>} completedQueueRows
 * @param {Map<string, { borrower_id?: string }>|Record<string, { borrower_id?: string }>} [loansByLoanId]
 */
function buildLoanIdsByBorrowerFromCompletedQueueRows(completedQueueRows, loansByLoanId = new Map()) {
  const loanIdsByBorrower = new Map();
  for (const row of completedQueueRows || []) {
    const loanId = trimId(row?.loan_id);
    const borrowerId = resolveBorrowerId(row, loansByLoanId);
    if (!loanId || !borrowerId) continue;
    if (!loanIdsByBorrower.has(borrowerId)) loanIdsByBorrower.set(borrowerId, new Set());
    loanIdsByBorrower.get(borrowerId).add(loanId);
  }
  return loanIdsByBorrower;
}

/**
 * @param {Array<{ loan_id?: string, borrower_id?: string }>} completedQueueRows
 * @param {Map<string, { borrower_id?: string }>|Record<string, { borrower_id?: string }>} [loansByLoanId]
 */
function summarizeCompletedDisbursementBreakdown(completedQueueRows, loansByLoanId = new Map()) {
  const loanIds = new Set();
  const loansPerBorrower = new Map();
  let orphanLoanCount = 0;

  for (const row of completedQueueRows || []) {
    const loanId = trimId(row?.loan_id);
    if (!loanId) continue;
    loanIds.add(loanId);

    const borrowerId = resolveBorrowerId(row, loansByLoanId);
    if (!borrowerId) {
      orphanLoanCount += 1;
      continue;
    }
    loansPerBorrower.set(borrowerId, (loansPerBorrower.get(borrowerId) || 0) + 1);
  }

  let firstTimeLoans = orphanLoanCount;
  let repeatLoans = 0;
  for (const loanCount of loansPerBorrower.values()) {
    firstTimeLoans += 1;
    if (loanCount > 1) repeatLoans += loanCount - 1;
  }

  const distinctBorrowers = uniqueBorrowersFromCompletedQueueRows(
    completedQueueRows,
    loansByLoanId,
  );

  return {
    total_loans: loanIds.size,
    first_time_loans: firstTimeLoans,
    repeat_loans: repeatLoans,
    distinct_borrowers: distinctBorrowers.size,
  };
}

module.exports = {
  summarizeCompletedDisbursementBreakdown,
  uniqueBorrowersFromCompletedQueueRows,
  buildLoanIdsByBorrowerFromCompletedQueueRows,
};
