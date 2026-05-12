'use strict';

function computeProfit(received, disbursed) {
  const r = Number(received) || 0;
  const d = Number(disbursed) || 0;
  return Math.round((r - d) * 100) / 100;
}

function profitStatusColor(profit) {
  const p = Number(profit) || 0;
  return p < 0 ? 'red' : 'green';
}

function customersOnlyDefinition() {
  // Current definition: cashier-confirmed disbursement only.
  return { cash_disbursement_confirmed: true };
}

/** Unpaid installment past due: DB overdue status, or pending with due_date before as-of. */
function invoiceIsUnpaidPastDue(row, asOfMs) {
  const st = String(row?.status || '');
  if (st === 'overdue') return true;
  if (st !== 'pending') return false;
  const due = row?.due_date != null ? new Date(row.due_date) : null;
  if (!due || Number.isNaN(due.getTime())) return false;
  return due.getTime() < asOfMs;
}

module.exports = {
  computeProfit,
  profitStatusColor,
  customersOnlyDefinition,
  invoiceIsUnpaidPastDue,
};

