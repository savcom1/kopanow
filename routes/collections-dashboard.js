'use strict';

const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { requireAdminDashboardAuth } = require('../helpers/adminDashboardAuth');
const {
  aggregateDueCustomerCounts,
  aggregateOverdueUnpaidBorrowerCount,
} = require('../helpers/collectionsDueCustomers');
const {
  summarizeBorrowerFcmCounts,
  fetchFcmByBorrower,
  buildCustomerFcmReachability,
  WITHOUT_FCM_CATEGORY_LABELS,
} = require('../helpers/customerFcmReachability');
const {
  fetchAllCompletedDisbursementQueueRows,
  COMPLETED_QUEUE_PAGE_SIZE,
  COMPLETED_QUEUE_MAX_PAGES,
} = require('../helpers/fetchCompletedDisbursementQueue');
const { buildLoanIdsByBorrowerFromCompletedQueueRows } = require('../helpers/loanoverviewDisbursementBreakdown');

const LIPA_PAGE_SIZE = 1000;
const LOAN_ID_IN_CHUNK = 150;
/** Safety cap: if hit, set truncated and stop (still a high bound for normal Lipa volume). */
const LIPA_MAX_PAGES = 50000;

function parseWindow(req) {
  const w = String(req.query.window || '').toLowerCase();
  if (w === 'day' || w === 'week' || w === 'month') return w;
  return 'day';
}

function computeFromToIso(req) {
  const fromRaw = req.query.from != null ? String(req.query.from).trim() : '';
  const toRaw = req.query.to != null ? String(req.query.to).trim() : '';
  if (fromRaw && toRaw) {
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      return { from: from.toISOString(), to: to.toISOString() };
    }
  }
  const now = new Date();
  const window = parseWindow(req);
  const ms =
    window === 'week' ? 7 * 86400000 : window === 'month' ? 30 * 86400000 : 86400000;
  const from = new Date(now.getTime() - ms);
  return { from: from.toISOString(), to: now.toISOString() };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function resolveAsOfIso(req) {
  const raw = req.query.as_of != null ? String(req.query.as_of).trim() : '';
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/** IANA zone for “due through end of today” on scheduled invoices (env override). */
function scheduledInvoiceDueTimeZone() {
  const t = String(process.env.KOPANOW_SCHEDULED_INVOICE_TZ || 'Africa/Dar_es_Salaam').trim();
  return t || 'Africa/Dar_es_Salaam';
}

/** Calendar YYYY-MM-DD in `timeZone` for this UTC instant. */
function zonedCalendarYmd(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return new Date().toLocaleDateString('en-CA', { timeZone });
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const by = {};
  for (const p of parts) {
    if (p.type !== 'literal') by[p.type] = p.value;
  }
  return `${by.year}-${by.month}-${by.day}`;
}

/**
 * Last UTC millisecond that still lies on the same calendar day as `asOfIso` in `timeZone`.
 * Used so `due_date <= cutoff` includes every installment due that local day (through “today”).
 */
function endOfZonedCalendarDayUtcIso(asOfIso, timeZone) {
  const ymd = zonedCalendarYmd(asOfIso, timeZone);
  const [y, mo, da] = ymd.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(da)) return asOfIso;
  const anchor = Date.UTC(y, mo - 1, da, 12, 0, 0, 0);
  const start = anchor - 48 * 3600000;
  const end = anchor + 48 * 3600000;
  let lastMinute = null;
  for (let t = start; t <= end; t += 60000) {
    if (zonedCalendarYmd(new Date(t).toISOString(), timeZone) === ymd) lastMinute = t;
  }
  if (lastMinute == null) return asOfIso;
  const refineEnd = lastMinute + 60000;
  let lastMs = lastMinute;
  for (let t = lastMinute; t < refineEnd; t += 1) {
    if (zonedCalendarYmd(new Date(t).toISOString(), timeZone) === ymd) lastMs = t;
  }
  return new Date(lastMs).toISOString();
}

async function fetchBorrowerByLoanId(loanIds) {
  const borrowerByLoanId = new Map();
  for (let i = 0; i < loanIds.length; i += LOAN_ID_IN_CHUNK) {
    const slice = loanIds.slice(i, i + LOAN_ID_IN_CHUNK);
    const { data, error } = await supabase
      .from('loans')
      .select('loan_id, borrower_id')
      .in('loan_id', slice);
    if (error) throw error;
    for (const row of data || []) {
      if (row.loan_id && row.borrower_id) {
        borrowerByLoanId.set(row.loan_id, String(row.borrower_id).trim());
      }
    }
  }
  return borrowerByLoanId;
}

/** Lipa totals sum `lipa_transactions.amount` for all rows in scope (not `payments`). */

/** Numeric value from row.amount (handles string decimals; odd column casing). */
function parseAmountFromRow(row) {
  if (row == null) return 0;
  const v =
    row.amount != null
      ? row.amount
      : row.Amount != null
        ? row.Amount
        : row['amount '] != null
          ? row['amount ']
          : null;
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(String(v).replace(/,/g, '').trim()) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Count all Lipa rows with ingested_at <= as_of. */
async function countLipaRowsTotalLeAsOf(asOfIso) {
  const { count, error } = await supabase
    .from('lipa_transactions')
    .select('id', { count: 'exact', head: true })
    .lte('ingested_at', asOfIso);
  if (error) throw error;
  return Number(count) || 0;
}

function pickAmountSumFromAggregate(data) {
  if (data == null) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (row == null || typeof row !== 'object') return null;
  let raw;
  if (row.sum !== undefined) raw = row.sum;
  else if (row.amount_sum !== undefined) raw = row.amount_sum;
  else if (row['amount.sum()'] !== undefined) raw = row['amount.sum()'];
  else return null;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? round2(n) : null;
}

/**
 * Grand Lipa totals for ingested_at <= as_of (no till/SMS/name filter).
 * Splits by claimed_borrower_id (schema: claimed Lipa vs still unclaimed).
 */
async function lipaGrandTotalsAndFlowLeAsOf(asOfIso) {
  let sumAll = null;
  let sumClaimed = null;
  let sumUnclaimed = null;
  try {
    const [allR, clR, uR] = await Promise.all([
      supabase.from('lipa_transactions').select('amount.sum()').lte('ingested_at', asOfIso),
      supabase
        .from('lipa_transactions')
        .select('amount.sum()')
        .lte('ingested_at', asOfIso)
        .not('claimed_borrower_id', 'is', null),
      supabase
        .from('lipa_transactions')
        .select('amount.sum()')
        .lte('ingested_at', asOfIso)
        .is('claimed_borrower_id', null),
    ]);
    if (!allR.error && allR.data != null) sumAll = pickAmountSumFromAggregate(allR.data);
    if (!clR.error && clR.data != null) sumClaimed = pickAmountSumFromAggregate(clR.data);
    if (!uR.error && uR.data != null) sumUnclaimed = pickAmountSumFromAggregate(uR.data);
  } catch (_) {
    /* fall through */
  }

  if (sumAll != null && sumClaimed != null && sumUnclaimed != null) {
    return {
      amount_all_tzs: sumAll,
      amount_claimed_tzs: sumClaimed,
      amount_unclaimed_tzs: sumUnclaimed,
      truncated: false,
      basis:
        'SUM(lipa_transactions.amount) via PostgREST amount.sum(); ingested_at <= as_of; claimed = claimed_borrower_id IS NOT NULL.',
    };
  }

  let sAll = 0;
  let sCl = 0;
  let sUcl = 0;
  let truncated = false;
  for (let page = 0; page < LIPA_MAX_PAGES; page++) {
    const fr = page * LIPA_PAGE_SIZE;
    const er = fr + LIPA_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('lipa_transactions')
      .select('amount,claimed_borrower_id')
      .lte('ingested_at', asOfIso)
      .order('ingested_at', { ascending: true })
      .order('id', { ascending: true })
      .range(fr, er);
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      const a = parseAmountFromRow(row);
      sAll += a;
      const claimed =
        row.claimed_borrower_id != null && String(row.claimed_borrower_id).trim() !== '';
      if (claimed) sCl += a;
      else sUcl += a;
    }
    if (rows.length < LIPA_PAGE_SIZE) break;
    if (page === LIPA_MAX_PAGES - 1) truncated = true;
  }
  return {
    amount_all_tzs: round2(sAll),
    amount_claimed_tzs: round2(sCl),
    amount_unclaimed_tzs: round2(sUcl),
    truncated,
    basis:
      'Paginated sum of lipa_transactions.amount; ingested_at <= as_of; claimed when claimed_borrower_id is non-empty.',
  };
}

/** Rolling Lipa: every row with ingested_at in [from, to] (no till/name/SMS filter). */
async function sumLipaWindowAllRows(fromIso, toIso) {
  let sum = 0;
  let rowCount = 0;
  let truncated = false;
  for (let page = 0; page < LIPA_MAX_PAGES; page++) {
    const fr = page * LIPA_PAGE_SIZE;
    const er = fr + LIPA_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('lipa_transactions')
      .select('amount')
      .gte('ingested_at', fromIso)
      .lte('ingested_at', toIso)
      .order('ingested_at', { ascending: true })
      .order('id', { ascending: true })
      .range(fr, er);
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      sum += parseAmountFromRow(row);
      rowCount += 1;
    }
    if (rows.length < LIPA_PAGE_SIZE) break;
    if (page === LIPA_MAX_PAGES - 1) truncated = true;
  }
  return { sum: round2(sum), rowCount, truncated };
}

function previewSelectCols() {
  return 'id,transaction_ref,amount,ingested_at,transaction_occurred_at,till_number,till_contract_name,payer_phone';
}

/** Latest N Lipa rows ingested ≤ as_of (entire table, newest first). */
async function fetchLipaPreviewAllRows(asOfIso, limit) {
  const { data, error } = await supabase
    .from('lipa_transactions')
    .select(previewSelectCols())
    .lte('ingested_at', asOfIso)
    .order('ingested_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/** Latest rows — admin-only sample for debugging ingestion shape. */
async function fetchLipaDebugSampleLeAsOf(asOfIso, limit) {
  const { data, error } = await supabase
    .from('lipa_transactions')
    .select('ingested_at,till_number,till_contract_name,raw_sms')
    .lte('ingested_at', asOfIso)
    .order('ingested_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const snip = (s, n) => (s == null ? null : String(s).slice(0, n));
  return (data || []).map((r) => ({
    ingested_at: r.ingested_at,
    till_number: r.till_number,
    till_contract_name: snip(r.till_contract_name, 160),
    raw_sms_preview: snip(r.raw_sms, 140),
  }));
}

router.use(requireAdminDashboardAuth);

router.get('/summary', async (req, res) => {
  try {
    const generatedAt = new Date().toISOString();
    const asOfIso = resolveAsOfIso(req);
    const { from, to } = computeFromToIso(req);

    const [lipaRowsTotalLeAsOf, lipaGrandTotals] = await Promise.all([
      countLipaRowsTotalLeAsOf(asOfIso),
      lipaGrandTotalsAndFlowLeAsOf(asOfIso),
    ]);

    /** Installment KPIs only include loans where cash was sent (queue completed), not applications. */
    const completedQueueRowsAll = await fetchAllCompletedDisbursementQueueRows(
      supabase,
      'loan_id, borrower_id',
    );
    const confirmedSet = new Set(
      completedQueueRowsAll.map((row) => row.loan_id).filter(Boolean),
    );
    const confirmedQueueTruncated =
      completedQueueRowsAll.length >= COMPLETED_QUEUE_PAGE_SIZE * COMPLETED_QUEUE_MAX_PAGES;

    const scheduledTz = scheduledInvoiceDueTimeZone();
    const scheduledDueCalendarYmd = zonedCalendarYmd(asOfIso, scheduledTz);
    const scheduledDueCutoffIso = endOfZonedCalendarDayUtcIso(asOfIso, scheduledTz);

    const [{ data: invRows, error: invErr }, { data: openInvRows, error: openInvErr }] =
      await Promise.all([
        supabase
          .from('loan_invoices')
          .select('loan_id, borrower_id, due_date, status, amount_due')
          .lte('due_date', scheduledDueCutoffIso)
          .in('status', ['pending', 'overdue', 'paid'])
          .limit(100000),
        supabase
          .from('loan_invoices')
          .select('loan_id, borrower_id, due_date, status, amount_due')
          .in('status', ['pending', 'overdue'])
          .limit(100000),
      ]);

    if (invErr) throw invErr;
    if (openInvErr) throw openInvErr;

    const customerInvRows = (invRows || []).filter((inv) => confirmedSet.has(inv.loan_id));
    const customerOpenInvRows = (openInvRows || []).filter((inv) => confirmedSet.has(inv.loan_id));
    const loanIdsMissingBorrower = new Set();
    for (const inv of [...customerInvRows, ...customerOpenInvRows]) {
      const raw = inv.borrower_id != null ? String(inv.borrower_id).trim() : '';
      if (!raw && inv.loan_id) loanIdsMissingBorrower.add(inv.loan_id);
    }
    const borrowerByLoanId = await fetchBorrowerByLoanId([...loanIdsMissingBorrower]);
    const asOfMs = new Date(asOfIso).getTime();
    const dueCustomerCounts = aggregateDueCustomerCounts({
      invoices: customerInvRows,
      confirmedLoanIds: confirmedSet,
      borrowerByLoanId,
      asOfMs,
    });
    const overdueUnpaidCounts = aggregateOverdueUnpaidBorrowerCount({
      openInvoices: customerOpenInvRows,
      confirmedLoanIds: confirmedSet,
      borrowerByLoanId,
      asOfMs,
    });

    const queueLoanIdsMissingBorrower = [
      ...new Set(
        completedQueueRowsAll
          .filter((row) => {
            const raw = row.borrower_id != null ? String(row.borrower_id).trim() : '';
            return !raw && row.loan_id;
          })
          .map((row) => row.loan_id),
      ),
    ];
    const loansByLoanIdForCustomers = new Map();
    if (queueLoanIdsMissingBorrower.length) {
      const borrowerByLoanId = await fetchBorrowerByLoanId(queueLoanIdsMissingBorrower);
      for (const [loanId, borrowerId] of borrowerByLoanId) {
        loansByLoanIdForCustomers.set(loanId, { borrower_id: borrowerId });
      }
    }
    const customerLoanIdsByBorrower = buildLoanIdsByBorrowerFromCompletedQueueRows(
      completedQueueRowsAll,
      loansByLoanIdForCustomers,
    );
    const customerBorrowerIds = [...customerLoanIdsByBorrower.keys()];
    const customerFcmReachability = await buildCustomerFcmReachability(
      supabase,
      customerBorrowerIds,
      customerLoanIdsByBorrower,
      { chunkSize: LOAN_ID_IN_CHUNK, reportLimit: 200 },
    );
    const overdueBorrowerIds = [...(overdueUnpaidCounts.overdue_loan_ids_by_borrower || new Map()).keys()];
    const overdueFcmByBorrower = await fetchFcmByBorrower(
      supabase,
      overdueBorrowerIds,
      overdueUnpaidCounts.overdue_loan_ids_by_borrower,
      LOAN_ID_IN_CHUNK,
    );
    const overdueFcmCounts = summarizeBorrowerFcmCounts(overdueBorrowerIds, overdueFcmByBorrower);

    let scheduledAmt = 0;
    let scheduledCount = 0;
    for (const inv of customerInvRows) {
      const amt = Number(inv.amount_due) || 0;
      scheduledAmt += amt;
      scheduledCount += 1;
    }

    const invoicesTruncated =
      (invRows || []).length >= 100000 || (openInvRows || []).length >= 100000;

    const windowAgg = await sumLipaWindowAllRows(from, to);

    const lipaPreview = await fetchLipaPreviewAllRows(asOfIso, 40);

    const wantDebug = String(req.query.debug_lipa || '').toLowerCase();
    const lipaDebugSample =
      wantDebug === '1' || wantDebug === 'true' || wantDebug === 'yes'
        ? await fetchLipaDebugSampleLeAsOf(asOfIso, 5)
        : undefined;

    return res.json({
      success: true,
      generated_at: generatedAt,
      as_of: asOfIso,
      lipa_amount_source_table: 'lipa_transactions',
      lipa_amount_column: 'amount',
      lipa_all_transactions: true,
      installment_loan_scope: 'cash_disbursement_queue_completed_only',
      ...(lipaDebugSample != null ? { lipa_debug_sample: lipaDebugSample } : {}),
      lipa_rows_total_le_as_of: lipaRowsTotalLeAsOf,
      lipa_grand_totals_le_as_of: {
        amount_all_tzs: lipaGrandTotals.amount_all_tzs,
        amount_claimed_tzs: lipaGrandTotals.amount_claimed_tzs,
        amount_unclaimed_tzs: lipaGrandTotals.amount_unclaimed_tzs,
        truncated: lipaGrandTotals.truncated,
        basis: lipaGrandTotals.basis,
      },
      lipa_transactions_preview: (lipaPreview || []).map((r) => ({
        transaction_ref: r.transaction_ref,
        amount: (() => {
          if (!r) return null;
          const has =
            r.amount != null || r.Amount != null || r['amount '] != null;
          return has ? round2(parseAmountFromRow(r)) : null;
        })(),
        ingested_at: r.ingested_at,
        transaction_occurred_at: r.transaction_occurred_at,
        till_number: r.till_number,
        till_contract_name: r.till_contract_name,
        payer_phone: r.payer_phone,
      })),
      definitions: {
        scheduled_through_as_of:
          'Sum of loan_invoices.amount_due for every row with status in (pending, overdue, paid) and due_date <= end of the calendar day of as_of in KOPANOW_SCHEDULED_INVOICE_TZ (default Africa/Dar_es_Salaam), for loans with completed cash disbursement only (see loan_scope_installments).',
        loan_scope_installments:
          'Scheduled installment metrics only include loan_id rows in cash_disbursement_queue with status = completed (cash sent). Pre-disbursement / application loans are excluded.',
        lipa_received_through_as_of:
          'amount_tzs = sum of lipa_transactions.amount for every row with ingested_at <= as_of (entire table; no till, SMS, or name filter). row_count is the exact head count lipa_rows_total_le_as_of.',
        lipa_rows_total_le_as_of:
          'Count of all lipa_transactions with ingested_at <= as_of.',
        lipa_grand_totals_le_as_of:
          'SUM(amount) for all lipa_transactions with ingested_at <= as_of. amount_claimed_tzs / amount_unclaimed_tzs split on claimed_borrower_id IS NOT NULL vs NULL.',
        lipa_rolling_window:
          'Sum of lipa_transactions.amount for every row with ingested_at in [from, to] (entire table; same scope as received).',
        till_note:
          'Lipa KPIs and preview scan the full lipa_transactions table; only ingested_at bounds apply. Query params till / strict_till / match / contract_sub are ignored.',
        due_customers_as_of:
          'Due reached / paid / open due use installments with due_date through end of the as_of calendar day in due_time_zone on completed cash disbursement loans. Overdue unpaid matches unpaid-invoices: open pending/overdue installments past due on customer loans (not limited to that due-through-today window).',
        customer_fcm_reachability:
          'Unique borrowers on completed cash disbursement loans. has_fcm_token is true when any matching devices row has a non-empty trimmed fcm_token for that borrower or loan_id (same rule as unpaid-invoices). without_fcm_by_category groups unreachable borrowers by device/loan status (admin_removed, suspended, active_missing_token, etc.).',
      },
      customer_fcm_reachability: {
        customers_total: customerBorrowerIds.length,
        with_fcm_token_count: customerFcmReachability.with_fcm_token_count,
        without_fcm_token_count: customerFcmReachability.without_fcm_token_count,
        without_fcm_by_category: customerFcmReachability.without_fcm_by_category,
        without_fcm_category_labels: WITHOUT_FCM_CATEGORY_LABELS,
        without_fcm_report: customerFcmReachability.without_fcm_report,
        overdue_unpaid: {
          borrower_count: overdueBorrowerIds.length,
          with_fcm_token_count: overdueFcmCounts.with_fcm_token_count,
          without_fcm_token_count: overdueFcmCounts.without_fcm_token_count,
        },
        definition: {
          scope_customers: 'loan_id in cash_disbursement_queue with status completed',
          fcm_token:
            'has_fcm_token is true when any matching devices row has a non-empty trimmed fcm_token for that borrower or customer loan_id',
          without_fcm_category:
            'Unreachable borrowers are classified from devices.status and loans.device_status on their cash-sent loans; admin_removed covers REMOVE_ADMIN / admin_removed device state.',
        },
      },
      due_customers_as_of: {
        due_reached_borrower_count: dueCustomerCounts.due_reached_borrower_count,
        paid_borrower_count: dueCustomerCounts.paid_borrower_count,
        overdue_borrower_count: overdueUnpaidCounts.overdue_borrower_count,
        open_due_borrower_count: dueCustomerCounts.open_due_borrower_count,
        installment_rows_considered: dueCustomerCounts.installment_rows_considered,
        overdue_installment_rows_considered: overdueUnpaidCounts.overdue_installment_rows_considered,
        due_time_zone: scheduledTz,
        due_calendar_date: scheduledDueCalendarYmd,
        due_cutoff_inclusive_iso: scheduledDueCutoffIso,
        definition: {
          scope_customers: 'loan_id in cash_disbursement_queue with status completed',
          due_reached:
            'Borrower has at least one invoice with due_date <= end of as_of local day and status in pending, overdue, or paid',
          overdue_unpaid:
            'Same as unpaid-invoices: status overdue, or status pending with due_date before as_of on open pending/overdue installments',
          paid:
            'Due-reached borrower with every due-window invoice status paid',
          open_due:
            'Due-reached borrower with at least one due-window invoice not paid',
          borrower_id:
            'Uses loan_invoices.borrower_id when set; otherwise loans.borrower_id for that loan_id',
        },
      },
      scheduled_installments_through_as_of: {
        amount_tzs: round2(scheduledAmt),
        invoice_count: scheduledCount,
        due_time_zone: scheduledTz,
        due_calendar_date: scheduledDueCalendarYmd,
        due_cutoff_inclusive_iso: scheduledDueCutoffIso,
        basis:
          'All invoices (pending, overdue, paid) with due_date through end of that calendar day in due_time_zone; loans limited to completed cash_disbursement_queue only.',
      },
      invoices_truncated: invoicesTruncated,
      confirmed_queue_truncated: confirmedQueueTruncated,
      lipa_received_through_as_of: {
        source_table: 'lipa_transactions',
        amount_column: 'amount',
        amount_tzs: lipaGrandTotals.amount_all_tzs,
        row_count: lipaRowsTotalLeAsOf,
        truncated: lipaGrandTotals.truncated,
        basis:
          'All lipa_transactions with ingested_at <= as_of; sum(amount). Same amount as lipa_grand_totals_le_as_of.amount_all_tzs.',
      },
      lipa_till: {
        source_table: 'lipa_transactions',
        amount_column: 'amount',
        window: parseWindow(req),
        window_from: from,
        window_to: to,
        amount_window_tzs: windowAgg.sum,
        row_count_window: windowAgg.rowCount,
        window_truncated: windowAgg.truncated,
        basis:
          'Rolling Lipa window: sum of lipa_transactions.amount for all rows with ingested_at in [from, to].',
      },
    });
  } catch (err) {
    console.error('[collections-dashboard:summary]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

module.exports = router;
