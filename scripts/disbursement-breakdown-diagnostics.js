'use strict';

require('dotenv').config();
const supabase = require('../helpers/supabase');
const { summarizeCompletedDisbursementBreakdown } = require('../helpers/loanoverviewDisbursementBreakdown');
const { fetchAllCompletedDisbursementQueueRows } = require('../helpers/fetchCompletedDisbursementQueue');

async function main() {
  const rows = await fetchAllCompletedDisbursementQueueRows(
    supabase,
    'loan_id, borrower_id, updated_at',
  );

  const missingLoanIds = [
    ...new Set(
      (rows || [])
        .filter((row) => !String(row?.borrower_id || '').trim() && row?.loan_id)
        .map((row) => row.loan_id),
    ),
  ];
  const loansByLoanId = new Map();
  if (missingLoanIds.length) {
    const { data: loans, error: loanErr } = await supabase
      .from('loans')
      .select('loan_id, borrower_id')
      .in('loan_id', missingLoanIds)
      .limit(100000);
    if (loanErr) throw loanErr;
    for (const loan of loans || []) {
      if (loan.loan_id) loansByLoanId.set(loan.loan_id, loan);
    }
  }

  const breakdown = summarizeCompletedDisbursementBreakdown(rows, loansByLoanId);
  const distinctBorrowersOnQueue = new Set(
    (rows || [])
      .map((row) => String(row?.borrower_id || '').trim())
      .filter(Boolean),
  ).size;

  console.log(
    JSON.stringify(
      {
        completed_rows: (rows || []).length,
        distinct_loan_ids: new Set((rows || []).map((r) => r.loan_id).filter(Boolean)).size,
        distinct_borrowers_on_queue: distinctBorrowersOnQueue,
        breakdown,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
