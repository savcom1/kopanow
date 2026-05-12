'use strict';

const COMPLETED_QUEUE_PAGE_SIZE = 1000;
const COMPLETED_QUEUE_MAX_PAGES = 200;

/**
 * PostgREST returns at most ~1000 rows per request; paginate for all-time completed queue KPIs.
 */
async function fetchAllCompletedDisbursementQueueRows(
  supabase,
  selectColumns = 'loan_id, borrower_id',
) {
  const rows = [];
  for (let page = 0; page < COMPLETED_QUEUE_MAX_PAGES; page++) {
    const from = page * COMPLETED_QUEUE_PAGE_SIZE;
    const to = from + COMPLETED_QUEUE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('cash_disbursement_queue')
      .select(selectColumns)
      .eq('status', 'completed')
      .order('updated_at', { ascending: true })
      .order('loan_id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < COMPLETED_QUEUE_PAGE_SIZE) break;
  }
  return rows;
}

async function fetchCompletedCustomerLoanIds(supabase) {
  const rows = await fetchAllCompletedDisbursementQueueRows(supabase, 'loan_id');
  return [...new Set(rows.map((row) => row.loan_id).filter(Boolean))];
}

module.exports = {
  fetchAllCompletedDisbursementQueueRows,
  fetchCompletedCustomerLoanIds,
  COMPLETED_QUEUE_PAGE_SIZE,
  COMPLETED_QUEUE_MAX_PAGES,
};
