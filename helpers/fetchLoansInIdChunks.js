'use strict';

const LOAN_ID_IN_CHUNK = 100;

async function fetchLoansInIdChunks(supabase, loanIds, selectColumns, opts = {}) {
  if (!loanIds.length) return [];
  const chunkSize = opts.chunkSize || LOAN_ID_IN_CHUNK;
  const rows = [];
  for (let i = 0; i < loanIds.length; i += chunkSize) {
    const chunk = loanIds.slice(i, i + chunkSize);
    let q = supabase.from('loans').select(selectColumns).in('loan_id', chunk);
    if (opts.gtOutstandingZero) q = q.gt('outstanding_amount', 0);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function selectRowsInIdChunks(supabase, table, idColumn, ids, selectColumns, opts = {}) {
  if (!ids.length) return [];
  const chunkSize = opts.chunkSize || LOAN_ID_IN_CHUNK;
  const rows = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    let q = supabase.from(table).select(selectColumns).in(idColumn, chunk);
    if (opts.eq) {
      for (const [key, value] of Object.entries(opts.eq)) {
        q = q.eq(key, value);
      }
    }
    if (opts.in) {
      for (const [key, value] of Object.entries(opts.in)) {
        q = q.in(key, value);
      }
    }
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

module.exports = {
  fetchLoansInIdChunks,
  selectRowsInIdChunks,
  LOAN_ID_IN_CHUNK,
};
