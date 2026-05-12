'use strict';
const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { requireAdminDashboardAuth } = require('../helpers/adminDashboardAuth');
const { customersOnlyDefinition } = require('../helpers/customersWorkflowKpi');
const {
  summarizeCompletedDisbursementBreakdown,
  uniqueBorrowersFromCompletedQueueRows,
} = require('../helpers/loanoverviewDisbursementBreakdown');
const { fetchAllCompletedDisbursementQueueRows } = require('../helpers/fetchCompletedDisbursementQueue');
const { selectRowsInIdChunks } = require('../helpers/fetchLoansInIdChunks');
const { buildAgingBucketsFromInvoices } = require('../helpers/customerPastDueInvoices');

function trimId(value) {
  if (value == null) return '';
  return String(value).trim();
}

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

async function fetchCompletedQueueLoanIdsSet(opts = {}) {
  let q = supabase
    .from('cash_disbursement_queue')
    .select('loan_id')
    .eq('status', 'completed')
    .limit(50000);
  if (opts.updatedAfterIso) q = q.gte('updated_at', opts.updatedAfterIso);
  if (opts.updatedBeforeIso) q = q.lte('updated_at', opts.updatedBeforeIso);
  const { data, error } = await q;
  if (error) throw error;
  return new Set((data || []).map((r) => r.loan_id).filter(Boolean));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** PostgREST often returns message "Bad Request" for oversized .in() filters — include details. */
function formatRouteError(err) {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  const m = err.message || err.msg || '';
  const d = err.details || '';
  const h = err.hint || '';
  const c = err.code || '';
  const parts = [m, d, h && `hint: ${h}`, c && `code: ${c}`].filter(Boolean);
  return parts.join(' · ') || String(err);
}

/** PostgREST URL limits: large .in(loan_id, ...) lists return 400 "Bad Request". */
const LOAN_ID_IN_CHUNK = 100;

async function fetchLoansInIdChunks(loanIds, selectColumns, opts = {}) {
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

router.use(requireAdminDashboardAuth);

// GET /api/admin/loanoverview/summary?window=day|week|month&from=ISO&to=ISO
router.get('/summary', async (req, res) => {
  try {
    const { from, to } = computeFromToIso(req);
    const generatedAt = new Date().toISOString();

    const [
      regsRes,
      regsTotalRes,
      completedWindowRes,
      pendingWindowRes,
      devicesProtectionsRes,
      lipaRes,
      paymentsRes,
      paymentRefsRes,
      withdrawnListRes,
      withdrawnTotalCountRes,
      withdrawnWindowCountRes,
    ] = await Promise.all([
      supabase
        .from('registrations')
        .select('borrower_id, created_at')
        .gte('created_at', from)
        .lte('created_at', to)
        .limit(50000),
      supabase.from('registrations').select('borrower_id', { count: 'exact', head: true }),
      supabase
        .from('cash_disbursement_queue')
        .select('loan_id, borrower_id, updated_at')
        .eq('status', 'completed')
        .gte('updated_at', from)
        .lte('updated_at', to)
        .limit(50000),
      supabase
        .from('cash_disbursement_queue')
        .select('loan_id, borrower_id, enqueued_at')
        .eq('status', 'pending')
        .gte('enqueued_at', from)
        .lte('enqueued_at', to)
        .limit(50000),
      supabase
        .from('devices')
        .select('loan_id, borrower_id, protection_first_completed_at')
        .not('protection_first_completed_at', 'is', null)
        .gte('protection_first_completed_at', from)
        .lte('protection_first_completed_at', to)
        .limit(50000),
      supabase
        .from('lipa_transactions')
        .select('amount, ingested_at, claimed_borrower_id')
        .gte('ingested_at', from)
        .lte('ingested_at', to)
        .limit(50000),
      supabase
        .from('payments')
        .select('amount, paid_at')
        .gte('paid_at', from)
        .lte('paid_at', to)
        .limit(50000),
      supabase
        .from('payment_references')
        .select('status, submitted_at')
        .gte('submitted_at', from)
        .lte('submitted_at', to)
        .limit(50000),
      supabase.from('loans').select('borrower_id').eq('device_status', 'withdrawn').limit(50000),
      supabase
        .from('loans')
        .select('loan_id', { count: 'exact', head: true })
        .eq('device_status', 'withdrawn'),
      supabase
        .from('loans')
        .select('loan_id', { count: 'exact', head: true })
        .eq('device_status', 'withdrawn')
        .gte('updated_at', from)
        .lte('updated_at', to),
    ]);

    for (const r of [
      regsRes,
      regsTotalRes,
      completedWindowRes,
      pendingWindowRes,
      devicesProtectionsRes,
      lipaRes,
      paymentsRes,
      paymentRefsRes,
      withdrawnListRes,
      withdrawnTotalCountRes,
      withdrawnWindowCountRes,
    ]) {
      if (r.error) throw r.error;
    }

    const completedQueueRowsAll = await fetchAllCompletedDisbursementQueueRows(
      supabase,
      'loan_id, borrower_id',
    );

    // Applicants vs customers (exclude voluntary in-app "futa programu" → device_status withdrawn)
    const regsWindowBorrowers = new Set((regsRes.data || []).map((r) => r.borrower_id).filter(Boolean));
    const completedWindowRows = completedWindowRes.data || [];
    const missingBorrowerLoanIds = [
      ...new Set(
        completedQueueRowsAll
          .filter((row) => !trimId(row?.borrower_id) && row?.loan_id)
          .map((row) => row.loan_id),
      ),
    ];
    const loansByLoanIdForCustomers = new Map();
    if (missingBorrowerLoanIds.length) {
      const borrowerLoans = await fetchLoansInIdChunks(
        missingBorrowerLoanIds,
        'loan_id, borrower_id',
      );
      for (const loan of borrowerLoans) {
        if (loan.loan_id) loansByLoanIdForCustomers.set(loan.loan_id, loan);
      }
    }
    const disbursementBreakdownAll = summarizeCompletedDisbursementBreakdown(
      completedQueueRowsAll,
      loansByLoanIdForCustomers,
    );
    const customersAllBorrowers = uniqueBorrowersFromCompletedQueueRows(
      completedQueueRowsAll,
      loansByLoanIdForCustomers,
    );
    const customersWindowBorrowers = uniqueBorrowersFromCompletedQueueRows(
      completedWindowRows,
      loansByLoanIdForCustomers,
    );

    const withdrawnLoanRows = withdrawnListRes.data || [];
    const withdrawnBorrowers = new Set(withdrawnLoanRows.map((r) => r.borrower_id).filter(Boolean));

    const applicantsWindow = [...regsWindowBorrowers].filter(
      (bid) => !customersAllBorrowers.has(bid) && !withdrawnBorrowers.has(bid),
    );

    // Disbursed (completed queue loans in window): count + sum principal
    const completedWindowLoanIds = [...new Set((completedWindowRes.data || []).map((r) => r.loan_id).filter(Boolean))];
    let disbursedPrincipalSum = 0;
    if (completedWindowLoanIds.length) {
      const disbLoans = await fetchLoansInIdChunks(
        completedWindowLoanIds,
        'loan_id, principal_amount',
      );
      for (const l of disbLoans) disbursedPrincipalSum += Number(l.principal_amount) || 0;
    }

    // Payments summaries
    let lipaTotal = 0;
    let lipaClaimed = 0;
    let lipaUnclaimed = 0;
    for (const t of lipaRes.data || []) {
      const a = Number(t.amount) || 0;
      lipaTotal += a;
      if (t.claimed_borrower_id) lipaClaimed += a;
      else lipaUnclaimed += a;
    }

    let paymentsTotal = 0;
    for (const p of paymentsRes.data || []) paymentsTotal += Number(p.amount) || 0;

    const paymentRefCounts = { pending: 0, verified: 0, rejected: 0, total: 0 };
    for (const pr of paymentRefsRes.data || []) {
      paymentRefCounts.total++;
      if (paymentRefCounts[pr.status] != null) paymentRefCounts[pr.status]++;
    }

    // Portfolio + PAR (completed loans only)
    const confirmedIds = [
      ...new Set(
        (await fetchAllCompletedDisbursementQueueRows(supabase, 'loan_id'))
          .map((row) => row.loan_id)
          .filter(Boolean),
      ),
    ];

    let portfolioGross = 0;
    let par1Bal = 0;
    let par30Bal = 0;
    let par90Bal = 0;

    if (confirmedIds.length) {
      const [loans, invs] = await Promise.all([
        fetchLoansInIdChunks(confirmedIds, 'loan_id, outstanding_amount', { gtOutstandingZero: true }),
        selectRowsInIdChunks(
          supabase,
          'loan_invoices',
          'loan_id',
          confirmedIds,
          'loan_id, due_date, status, amount_due',
          { in: { status: ['pending', 'overdue'] } },
        ),
      ]);

      const asOfMs = Date.now();
      const dayMs = 86400000;
      const loanIdSet = new Set((loans || []).map((l) => l.loan_id));
      const loanMaxDaysPast = new Map();

      for (const inv of invs || []) {
        if (!loanIdSet.has(inv.loan_id)) continue;
        const due = new Date(inv.due_date).getTime();
        if (Number.isNaN(due) || due >= asOfMs) continue;
        const daysPast = Math.floor((asOfMs - due) / dayMs);
        const cur = loanMaxDaysPast.get(inv.loan_id) || 0;
        loanMaxDaysPast.set(inv.loan_id, Math.max(cur, daysPast));
      }

      for (const l of loans || []) {
        const o = Number(l.outstanding_amount) || 0;
        if (o <= 0) continue;
        portfolioGross += o;
        const maxD = loanMaxDaysPast.get(l.loan_id) || 0;
        if (maxD >= 1) par1Bal += o;
        if (maxD >= 30) par30Bal += o;
        if (maxD >= 90) par90Bal += o;
      }
    }

    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

    // Aging buckets (AR aging, completed loans only)
    let agingBuckets = {
      upcoming: { label: 'Not yet due', amount: 0, count: 0 },
      days_1_30: { label: '1–30 days past due', amount: 0, count: 0 },
      days_31_60: { label: '31–60 days past due', amount: 0, count: 0 },
      days_61_90: { label: '61–90 days past due', amount: 0, count: 0 },
      days_90_plus: { label: '90+ days past due', amount: 0, count: 0 },
    };
    if (confirmedIds.length) {
      const agingInvs = await selectRowsInIdChunks(
        supabase,
        'loan_invoices',
        'loan_id',
        confirmedIds,
        'loan_id, due_date, status, amount_due',
        { in: { status: ['pending', 'overdue'] } },
      );
      agingBuckets = buildAgingBucketsFromInvoices(agingInvs);
    }
    const agingTotalReceivable = round2(Object.values(agingBuckets).reduce((s, b) => s + b.amount, 0));

    // Ops funnel counts (window)
    const protectionsCompleteCount = (devicesProtectionsRes.data || []).length;
    const queuePendingCount = (pendingWindowRes.data || []).length;
    const queueCompletedCount = (completedWindowRes.data || []).length;

    return res.json({
      success: true,
      generated_at: generatedAt,
      window: parseWindow(req),
      from,
      to,
      counts: {
        registrations_in_window: regsWindowBorrowers.size,
        customers_in_window: customersWindowBorrowers.size,
        applicants_in_window: applicantsWindow.length,
        customers_total: customersAllBorrowers.size,
        completed_disbursement_loans_total: disbursementBreakdownAll.total_loans,
        first_time_disbursement_loans_total: disbursementBreakdownAll.first_time_loans,
        repeat_disbursement_loans_total: disbursementBreakdownAll.repeat_loans,
        customers_only_definition: customersOnlyDefinition(),
        registrations_total: regsTotalRes.count || null,
        withdrawn_loans_total: withdrawnTotalCountRes.count ?? 0,
        withdrawn_loans_in_window: withdrawnWindowCountRes.count ?? 0,
      },
      disbursed: {
        completed_loan_count_in_window: completedWindowLoanIds.length,
        principal_sum_in_window: round2(disbursedPrincipalSum),
      },
      payments: {
        lipa: {
          total_amount: round2(lipaTotal),
          claimed_amount: round2(lipaClaimed),
          unclaimed_amount: round2(lipaUnclaimed),
          row_count: (lipaRes.data || []).length,
          basis: 'lipa_transactions.ingested_at',
        },
        verified: {
          total_amount: round2(paymentsTotal),
          row_count: (paymentsRes.data || []).length,
          basis: 'payments.paid_at',
        },
        payment_references: {
          counts: paymentRefCounts,
          basis: 'payment_references.submitted_at',
        },
      },
      portfolio: {
        gross_outstanding: round2(portfolioGross),
        par: {
          par1: { balance: round2(par1Bal), pct: pct(par1Bal, portfolioGross) },
          par30: { balance: round2(par30Bal), pct: pct(par30Bal, portfolioGross) },
          par90: { balance: round2(par90Bal), pct: pct(par90Bal, portfolioGross) },
        },
        definition: 'Loans filtered to cash_disbursement_queue.status=completed for portfolio + PAR.',
      },
      aging: {
        buckets: agingBuckets,
        total_receivable: agingTotalReceivable,
        definition: 'Unpaid invoices (pending/overdue) for completed (customer) loans only.',
      },
      operations: {
        protections_completed_in_window: protectionsCompleteCount,
        queue_pending_enqueued_in_window: queuePendingCount,
        queue_completed_updated_in_window: queueCompletedCount,
      },
    });
  } catch (err) {
    const msg = formatRouteError(err);
    console.error('[loanoverview:summary]', msg);
    return res.status(500).json({ success: false, error: msg || 'Internal server error' });
  }
});

module.exports = router;

