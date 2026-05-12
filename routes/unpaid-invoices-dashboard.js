'use strict';

const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { requireAdminDashboardAuth } = require('../helpers/adminDashboardAuth');
const { invoiceIsUnpaidPastDue } = require('../helpers/customersWorkflowKpi');
const { buildFcmByBorrower } = require('../helpers/unpaidInvoicesFcm');

const CUSTOMER_LOAN_LIMIT = 100000;
const INVOICE_LIMIT = 100000;
const CHUNK_SIZE = 150;

function resolveAsOfMs(req) {
  const raw = req.query.as_of != null ? String(req.query.as_of).trim() : '';
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return Date.now();
}

async function fetchCustomerLoanIds() {
  const { data, error } = await supabase
    .from('cash_disbursement_queue')
    .select('loan_id')
    .eq('status', 'completed')
    .limit(CUSTOMER_LOAN_LIMIT);
  if (error) throw error;
  const rows = data || [];
  return {
    loanIds: [...new Set(rows.map((r) => r.loan_id).filter(Boolean))],
    truncated: rows.length >= CUSTOMER_LOAN_LIMIT,
  };
}

async function fetchBorrowerByLoanId(loanIds) {
  const borrowerByLoanId = new Map();
  for (let i = 0; i < loanIds.length; i += CHUNK_SIZE) {
    const slice = loanIds.slice(i, i + CHUNK_SIZE);
    const { data: loanRows, error } = await supabase
      .from('loans')
      .select('loan_id, borrower_id')
      .in('loan_id', slice);
    if (error) throw error;
    for (const l of loanRows || []) {
      if (l.loan_id && l.borrower_id) {
        borrowerByLoanId.set(l.loan_id, String(l.borrower_id).trim());
      }
    }
  }
  return borrowerByLoanId;
}

async function fetchRegistrationsByBorrower(borrowerIds) {
  const regByBorrower = new Map();
  for (let i = 0; i < borrowerIds.length; i += CHUNK_SIZE) {
    const slice = borrowerIds.slice(i, i + CHUNK_SIZE);
    const { data: regs, error } = await supabase
      .from('registrations')
      .select('borrower_id, full_name, phone')
      .in('borrower_id', slice);
    if (error) throw error;
    for (const r of regs || []) regByBorrower.set(r.borrower_id, r);
  }
  return regByBorrower;
}

async function fetchFcmByBorrower(borrowerIds, loanIdsByBorrower) {
  const loanToBorrowers = new Map();
  for (const [, loanIds] of loanIdsByBorrower) {
    for (const lid of loanIds) {
      if (!lid) continue;
      if (!loanToBorrowers.has(lid)) loanToBorrowers.set(lid, true);
    }
  }
  const loanIdsOnly = [...loanToBorrowers.keys()];

  const deviceRowsByBorrower = [];
  for (let i = 0; i < borrowerIds.length; i += CHUNK_SIZE) {
    const slice = borrowerIds.slice(i, i + CHUNK_SIZE);
    const { data: byBorrower, error: bErr } = await supabase
      .from('devices')
      .select('borrower_id, loan_id, fcm_token')
      .in('borrower_id', slice);
    if (bErr) throw bErr;
    deviceRowsByBorrower.push(...(byBorrower || []));
  }

  const deviceRowsByLoan = [];
  for (let i = 0; i < loanIdsOnly.length; i += CHUNK_SIZE) {
    const slice = loanIdsOnly.slice(i, i + CHUNK_SIZE);
    const { data: byLoan, error: lErr } = await supabase
      .from('devices')
      .select('borrower_id, loan_id, fcm_token')
      .in('loan_id', slice);
    if (lErr) throw lErr;
    deviceRowsByLoan.push(...(byLoan || []));
  }

  return buildFcmByBorrower(borrowerIds, loanIdsByBorrower, deviceRowsByBorrower, deviceRowsByLoan);
}

router.use(requireAdminDashboardAuth);

router.get('/summary', async (req, res) => {
  try {
    const asOfMs = resolveAsOfMs(req);
    const asOfIso = new Date(asOfMs).toISOString();
    const generatedAt = new Date().toISOString();

    const { loanIds: customerLoanIds, truncated: customerLoanIdsTruncated } = await fetchCustomerLoanIds();
    const allowedLoanIds = new Set(customerLoanIds);

    if (!customerLoanIds.length) {
      return res.json({
        success: true,
        generated_at: generatedAt,
        as_of: asOfIso,
        scope: 'customers',
        definition: {
          overdue_invoice:
            'status overdue, or status pending with due_date before as_of',
          borrower_id:
            'Uses loan_invoices.borrower_id when set; otherwise loans.borrower_id for that loan_id.',
          scope_customers: 'loan_id in cash_disbursement_queue with status completed',
          fcm_token:
            'has_fcm_token is true when any matching devices row has a non-empty trimmed fcm_token for that borrower or overdue loan_id.',
          sort: 'max_days_past_due descending',
        },
        counts: {
          borrower_count: 0,
          with_fcm_token_count: 0,
          without_fcm_token_count: 0,
          overdue_installment_rows_considered: 0,
        },
        truncation: {
          invoices_truncated: false,
          customer_loan_ids_truncated: customerLoanIdsTruncated,
        },
        borrowers: [],
        note: 'No customer loans on file (no completed cash disbursement queue rows).',
      });
    }

    const { data: invRaw, error: iErr } = await supabase
      .from('loan_invoices')
      .select('loan_id, borrower_id, invoice_number, installment_index, amount_due, due_date, status')
      .in('status', ['pending', 'overdue'])
      .limit(INVOICE_LIMIT);
    if (iErr) throw iErr;

    const invoicesTruncated = (invRaw || []).length >= INVOICE_LIMIT;
    const filtered = [];
    for (const inv of invRaw || []) {
      if (!allowedLoanIds.has(inv.loan_id)) continue;
      if (!invoiceIsUnpaidPastDue(inv, asOfMs)) continue;
      filtered.push(inv);
    }

    const loanIdsMissingBorrower = new Set();
    for (const inv of filtered) {
      const raw = inv.borrower_id != null ? String(inv.borrower_id).trim() : '';
      if (!raw && inv.loan_id) loanIdsMissingBorrower.add(inv.loan_id);
    }
    const borrowerByLoanId = await fetchBorrowerByLoanId([...loanIdsMissingBorrower]);

    const agg = new Map();
    for (const inv of filtered) {
      let bid = inv.borrower_id != null ? String(inv.borrower_id).trim() : '';
      if (!bid && inv.loan_id) bid = borrowerByLoanId.get(inv.loan_id) || '';
      if (!bid) continue;
      const dueMs = inv.due_date != null ? new Date(inv.due_date).getTime() : NaN;
      const daysPast = Number.isNaN(dueMs) ? 0 : Math.max(0, Math.floor((asOfMs - dueMs) / 86400000));
      if (!agg.has(bid)) {
        agg.set(bid, {
          borrower_id: bid,
          overdue_installment_count: 0,
          total_amount_due: 0,
          oldest_due_date: inv.due_date || null,
          max_days_past_due: daysPast,
          loan_ids: new Set(),
        });
      }
      const a = agg.get(bid);
      a.overdue_installment_count += 1;
      a.total_amount_due += Number(inv.amount_due) || 0;
      if (inv.loan_id) a.loan_ids.add(inv.loan_id);
      if (inv.due_date) {
        const curOldest = a.oldest_due_date ? new Date(a.oldest_due_date).getTime() : Infinity;
        const thisDue = new Date(inv.due_date).getTime();
        if (!Number.isNaN(thisDue) && thisDue < curOldest) a.oldest_due_date = inv.due_date;
      }
      if (daysPast > a.max_days_past_due) a.max_days_past_due = daysPast;
    }

    const borrowerIds = [...agg.keys()];
    const loanIdsByBorrower = new Map(
      [...agg.values()].map((a) => [a.borrower_id, a.loan_ids]),
    );

    const [regByBorrower, fcmByBorrower] = await Promise.all([
      fetchRegistrationsByBorrower(borrowerIds),
      fetchFcmByBorrower(borrowerIds, loanIdsByBorrower),
    ]);

    let withFcmTokenCount = 0;
    let withoutFcmTokenCount = 0;
    const borrowers = [...agg.values()]
      .map((a) => {
        const reg = regByBorrower.get(a.borrower_id);
        const hasFcmToken = fcmByBorrower.get(a.borrower_id) === true;
        if (hasFcmToken) withFcmTokenCount += 1;
        else withoutFcmTokenCount += 1;
        return {
          borrower_id: a.borrower_id,
          full_name: reg?.full_name != null ? String(reg.full_name).trim() || null : null,
          phone: reg?.phone != null ? String(reg.phone).trim() || null : null,
          overdue_installment_count: a.overdue_installment_count,
          total_amount_due: Math.round(a.total_amount_due * 100) / 100,
          oldest_due_date: a.oldest_due_date,
          max_days_past_due: a.max_days_past_due,
          loan_ids: [...a.loan_ids].sort(),
          has_fcm_token: hasFcmToken,
        };
      })
      .sort((x, y) => y.max_days_past_due - x.max_days_past_due);

    return res.json({
      success: true,
      generated_at: generatedAt,
      as_of: asOfIso,
      scope: 'customers',
      definition: {
        overdue_invoice:
          'status overdue, or status pending with due_date before as_of',
        borrower_id:
          'Uses loan_invoices.borrower_id when set; otherwise loans.borrower_id for that loan_id.',
        scope_customers: 'loan_id in cash_disbursement_queue with status completed',
        fcm_token:
          'has_fcm_token is true when any matching devices row has a non-empty trimmed fcm_token for that borrower or overdue loan_id.',
        sort: 'max_days_past_due descending',
      },
      counts: {
        borrower_count: borrowers.length,
        with_fcm_token_count: withFcmTokenCount,
        without_fcm_token_count: withoutFcmTokenCount,
        overdue_installment_rows_considered: filtered.length,
      },
      truncation: {
        invoices_truncated: invoicesTruncated,
        customer_loan_ids_truncated: customerLoanIdsTruncated,
      },
      borrowers,
    });
  } catch (err) {
    console.error('[unpaid-invoices-dashboard:summary]', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
  }
});

module.exports = router;
