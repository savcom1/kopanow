'use strict';

function hasTrimmedFcmToken(value) {
  return String(value || '').trim().length > 0;
}

function buildLoanToBorrowersMap(loanIdsByBorrower) {
  const loanToBorrowers = new Map();
  for (const [bid, loanIds] of loanIdsByBorrower) {
    for (const lid of loanIds) {
      if (!lid) continue;
      if (!loanToBorrowers.has(lid)) loanToBorrowers.set(lid, new Set());
      loanToBorrowers.get(lid).add(bid);
    }
  }
  return loanToBorrowers;
}

function applyFcmRowsToBorrowers(fcmByBorrower, borrowerIdSet, loanToBorrowers, rows) {
  for (const row of rows || []) {
    const hasToken = hasTrimmedFcmToken(row.fcm_token);
    const bid = row.borrower_id != null ? String(row.borrower_id).trim() : '';
    if (bid && borrowerIdSet.has(bid) && hasToken) fcmByBorrower.set(bid, true);

    const lid = row.loan_id != null ? String(row.loan_id).trim() : '';
    const borrowersForLoan = loanToBorrowers.get(lid);
    if (!borrowersForLoan || !hasToken) continue;
    for (const borrowerId of borrowersForLoan) {
      if (borrowerIdSet.has(borrowerId)) fcmByBorrower.set(borrowerId, true);
    }
  }
}

function buildFcmByBorrower(borrowerIds, loanIdsByBorrower, deviceRowsByBorrower, deviceRowsByLoan) {
  const borrowerIdSet = new Set(borrowerIds);
  const fcmByBorrower = new Map();
  for (const bid of borrowerIds) fcmByBorrower.set(bid, false);

  const loanToBorrowers = buildLoanToBorrowersMap(loanIdsByBorrower);
  applyFcmRowsToBorrowers(fcmByBorrower, borrowerIdSet, loanToBorrowers, deviceRowsByBorrower);
  applyFcmRowsToBorrowers(fcmByBorrower, borrowerIdSet, loanToBorrowers, deviceRowsByLoan);
  return fcmByBorrower;
}

module.exports = {
  hasTrimmedFcmToken,
  buildLoanToBorrowersMap,
  applyFcmRowsToBorrowers,
  buildFcmByBorrower,
};
