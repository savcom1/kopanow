'use strict';

const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { logAccountingAudit } = require('../helpers/accountingAudit');
const { normalizePhone } = require('../helpers/deviceEnrollment');
const {
  isPhoneBlockedForDisbursement,
  getBlockedCanonicalPhoneSet,
} = require('../helpers/disbursementBlocklist');
const { fetchAiRetailPriceTzs } = require('../helpers/aiRetailPriceTz');
const { computeMkopoFromRetailPrice } = require('../helpers/mkopoRetailPricing');
const { fetchAnthropicPhonePrice } = require('../helpers/anthropicPhonePrice');
const {
  computeProfit,
  profitStatusColor,
  customersOnlyDefinition,
  invoiceIsUnpaidPastDue,
} = require('../helpers/customersWorkflowKpi');
const { summarizeCompletedDisbursementBreakdown } = require('../helpers/loanoverviewDisbursementBreakdown');
const {
  fetchAllCompletedDisbursementQueueRows,
  fetchCompletedCustomerLoanIds,
} = require('../helpers/fetchCompletedDisbursementQueue');
const {
  fetchLoansInIdChunks,
  selectRowsInIdChunks,
} = require('../helpers/fetchLoansInIdChunks');
const { summarizePastDueInvoices } = require('../helpers/customerPastDueInvoices');

function quoteBorrowerIdsForInFilter(ids) {
  return ids.map((id) => {
    const s = String(id);
    return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
}

function summarizeInvoiceRows(rows) {
  if (!rows?.length) return null;
  const counts = { pending: 0, paid: 0, overdue: 0 };
  for (const r of rows) {
    if (counts[r.status] != null) counts[r.status]++;
  }
  const nextUnpaid = rows.find((i) => i.status === 'pending' || i.status === 'overdue');
  return {
    ...counts,
    total: rows.length,
    next_due_date: nextUnpaid?.due_date || null,
  };
}

const { getExpectedAdminDashboardKey } = require('../helpers/adminDashboardAuth');

/**
 * When any secret is set, require either x-accounting-key (legacy) or the same admin key as LoanOverview (x-admin-key).
 */
function requireAccountingAuth(req, res, next) {
  const accountingSecret = String(process.env.ACCOUNTING_API_SECRET || '').trim();
  const adminKey = getExpectedAdminDashboardKey();

  if (!accountingSecret && !adminKey) return next();

  const acc = String(req.headers['x-accounting-key'] || '').trim();
  const adm = String(req.headers['x-admin-key'] || '').trim();

  if (accountingSecret && acc === accountingSecret) return next();
  if (adminKey && adm === adminKey) return next();

  return res.status(401).json({
    success: false,
    error: 'Invalid or missing auth: send x-admin-key (ADMIN_KEY) or x-accounting-key header',
  });
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvRow(cols) {
  return cols.map(csvEscape).join(',');
}

/** When false (default), portfolio reports only include cashier-confirmed loans. */
function includeIncompleteLoans(req) {
  const v = req.query.include_incomplete;
  return v === '1' || v === 'true' || v === 'yes';
}

// ── Customers-workflow KPI cache (best-effort) ───────────────────────────────
let customersWorkflowCache = { at_ms: 0, payload: null };
const CUSTOMERS_WORKFLOW_CACHE_MS = 45_000;

async function computeCustomersOnlyLoanIds() {
  return fetchCompletedCustomerLoanIds(supabase);
}

async function fetchConfirmedLoanIdsSet() {
  // Treat "confirmed/complete" loans as those with cash disbursement queue status completed.
  const { data, error } = await supabase
    .from('cash_disbursement_queue')
    .select('loan_id')
    .eq('status', 'completed')
    .limit(50000);
  if (error) throw error;
  return new Set((data || []).map((r) => r.loan_id));
}

// ── Borrower app: canonical loan routes at /api/accounting/loan/* (legacy duplicate: /api/loan/*) ──
// Mounted here so Render deployments that only wire /api/accounting still accept registrations.
const loanRouter = require('./loan');
router.use('/loan', loanRouter);

// ── GET /api/accounting/health (no auth — load balancers) ───────────────────
// Optional: ?check=supabase — one lightweight query to verify service_role key + URL (no secrets returned).
router.get('/health', async (req, res) => {
  const wantDb = req.query.check === 'supabase' || req.query.check === '1';
  if (!wantDb) {
    return res.json({ ok: true, module: 'accounting' });
  }
  try {
    const { error } = await supabase.from('registrations').select('borrower_id').limit(1);
    if (error) {
      return res.json({
        ok: true,
        module: 'accounting',
        supabase: {
          ok: false,
          code: error.code,
          message: error.message,
          hint:
            error.message?.includes('JWT') || error.message?.includes('Invalid API key')
              ? 'Update SUPABASE_SERVICE_KEY on the host with the current service_role key from Supabase → Project Settings → API.'
              : error.hint || undefined,
        },
      });
    }
    return res.json({ ok: true, module: 'accounting', supabase: { ok: true } });
  } catch (e) {
    return res.json({
      ok: true,
      module: 'accounting',
      supabase: { ok: false, message: e.message || String(e) },
    });
  }
});

/**
 * POST /api/accounting/device/unsupported
 * Public (no x-accounting-key): borrower Android app reports a phone not in the bundled MKOPO catalog.
 * Admin lists rows via GET /api/accounting/device/unsupported (authenticated).
 */
router.post('/device/unsupported', async (req, res) => {
  try {
    const b = req.body || {};
    const fullName = b.full_name != null ? String(b.full_name).trim() : '';
    const phoneNorm = normalizePhone(b.phone);
    const manufacturer = String(b.manufacturer || '').trim();
    const brand = String(b.brand || '').trim();
    const deviceModel = String(b.device_model || '').trim();

    if (!manufacturer || !brand || !deviceModel) {
      return res.status(400).json({
        success: false,
        message: 'manufacturer, brand, and device_model are required',
      });
    }

    const hasName = fullName.length >= 2;
    const hasPhone = !!phoneNorm;
    if (hasName !== hasPhone) {
      return res.status(400).json({
        success: false,
        message:
          'Provide both full_name and a valid TZ phone (255… or 07…), or omit both for a device-only report',
      });
    }

    const row = {
      borrower_id: b.borrower_id != null ? String(b.borrower_id).trim() || null : null,
      full_name: hasName ? fullName : null,
      phone: hasPhone ? phoneNorm : null,
      national_id: b.national_id != null ? String(b.national_id).trim() || null : null,
      region: b.region != null ? String(b.region).trim() || null : null,
      address: b.address != null ? String(b.address).trim() || null : null,
      manufacturer,
      brand,
      device_model: deviceModel,
      build_device: b.build_device != null ? String(b.build_device).trim() || null : null,
      build_product: b.build_product != null ? String(b.build_product).trim() || null : null,
      android_version: b.android_version != null ? String(b.android_version).trim() || null : null,
      sdk_version:
        typeof b.sdk_version === 'number'
          ? b.sdk_version
          : Number.isFinite(parseInt(b.sdk_version, 10))
            ? parseInt(b.sdk_version, 10)
            : null,
      device_id: b.device_id != null ? String(b.device_id).trim() || null : null,
      imei:
        b.imei != null
          ? String(b.imei)
              .replace(/\D/g, '')
              .slice(0, 32) || null
          : null,
      app_version_code:
        typeof b.app_version_code === 'number'
          ? b.app_version_code
          : Number.isFinite(parseInt(b.app_version_code, 10))
            ? parseInt(b.app_version_code, 10)
            : null,
      app_version_name:
        b.app_version_name != null ? String(b.app_version_name).trim().slice(0, 64) || null : null,
      client_timestamp_ms:
        typeof b.timestamp === 'number'
          ? b.timestamp
          : Number.isFinite(parseInt(b.timestamp, 10))
            ? parseInt(b.timestamp, 10)
            : null,
    };

    const { error } = await supabase.from('mkopo_unsupported_device_reports').insert(row);
    if (error) {
      console.error('[mkopo_unsupported] insert', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Could not save report — ensure migration ran on Supabase.',
      });
    }
    return res.json({ success: true, message: 'Report saved' });
  } catch (e) {
    console.error('[mkopo_unsupported] POST', e);
    return res.status(500).json({ success: false, message: e.message || String(e) });
  }
});

router.use(requireAccountingAuth);

// ── GET /api/accounting/device/unsupported ───────────────────────────────────
// List phones reported as missing from MKOPO catalog (admin dashboard).
router.get('/device/unsupported', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10) || 100;
    if (limit > 500) limit = 500;
    if (limit < 1) limit = 1;
    const pricedQ = req.query.priced;
    const wantPriced =
      pricedQ === '1' || pricedQ === 'true' || pricedQ === 'yes'
        ? true
        : pricedQ === '0' || pricedQ === 'false' || pricedQ === 'no'
          ? false
          : null;

    let q = supabase
      .from('mkopo_unsupported_device_reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (wantPriced === true) q = q.not('retail_price_tzs', 'is', null);
    if (wantPriced === false) q = q.is('retail_price_tzs', null);

    const { data, error } = await q;
    if (error) throw error;
    return res.json({ success: true, items: data || [] });
  } catch (e) {
    console.error('[mkopo_unsupported] GET', e);
    return res.status(500).json({ success: false, error: e.message || String(e), items: [] });
  }
});

// ── POST /api/accounting/device/unsupported/:id/ai-price ─────────────────────
// Admin-triggered: fetch retail price (TZS) via web search + scraping.
router.post('/device/unsupported/:id/ai-price', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const { data: row, error: fErr } = await supabase
      .from('mkopo_unsupported_device_reports')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!row) return res.status(404).json({ success: false, error: 'Not found' });

    const label = [row.brand || row.manufacturer || '', row.device_model || ''].filter(Boolean).join(' ').trim();
    if (!label) return res.status(422).json({ success: false, error: 'missing_device_label' });

    // Prefer Anthropic web_search tool (more reliable than scraping search engines).
    // Fallback to our scraping implementation if Anthropic is not configured.
    let ai = null;
    let sources = null;
    let confidence = 0;
    let priceTzs = null;

    const anth = await fetchAnthropicPhonePrice({ phone: label });
    if (anth.ok && anth.price_tzs != null) {
      priceTzs = Math.round(Number(anth.price_tzs));
      confidence = 0.85;
      sources = [
        {
          title: anth.source || 'anthropic_web_search',
          url: null,
          amount: anth.price_usd,
          currency: 'USD',
          price_tzs: priceTzs,
          captured_at: new Date().toISOString(),
          phone: anth.phone,
        },
      ];
      ai = { ok: true, price_tzs: priceTzs, confidence, sources };
    } else if (String(anth.error || '') === 'missing_anthropic_api_key') {
      // Only fallback when Anthropic is not configured.
      const scr = await fetchAiRetailPriceTzs({
        manufacturer: row.manufacturer,
        brand: row.brand,
        device_model: row.device_model,
      });
      if (!scr.ok) {
        return res.status(422).json({ success: false, error: scr.error || 'ai_price_failed' });
      }
      ai = scr;
      priceTzs = scr.price_tzs;
      confidence = scr.confidence;
      sources = scr.sources;
    } else {
      // Anthropic attempted but failed (or returned no price).
      return res.status(422).json({ success: false, error: anth.error || 'ai_price_failed' });
    }

    const now = new Date().toISOString();
    const patch = {
      ai_price_tzs: priceTzs,
      ai_price_confidence: confidence,
      ai_price_sources: sources,
      ai_priced_at: now,
    };

    // Optional auto-fill: if confidence is strong, promote AI price to official retail price.
    // This still remains editable via the PATCH pricing endpoint.
    if (confidence >= 0.7) {
      const comp = computeMkopoFromRetailPrice({ retail_price_amount: priceTzs, fx_rate_to_tzs: 1 });
      if (comp.ok) {
        patch.retail_price_amount = priceTzs;
        patch.retail_price_currency = 'TZS';
        patch.fx_rate_to_tzs = 1;
        patch.retail_price_tzs = comp.retail_price_tzs;
        patch.mkopo_max_loan_tzs = comp.mkopo_max_loan_tzs;
        patch.mkopo_first_loan_tzs = comp.mkopo_first_loan_tzs;
        patch.priced_by = 'ai';
        patch.priced_at = now;
        patch.pricing_notes = 'Auto-filled from AI price (confidence >= 0.7).';
      }
    }

    const { data: updated, error: uErr } = await supabase
      .from('mkopo_unsupported_device_reports')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (uErr) throw uErr;

    return res.json({ success: true, item: updated });
  } catch (err) {
    console.error('[mkopo_unsupported] ai-price', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
  }
});

// ── PATCH /api/accounting/device/unsupported/:id/pricing ─────────────────────
// Manual/override pricing with stored FX and derived MKOPO amounts.
router.patch('/device/unsupported/:id/pricing', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const b = req.body || {};
    const retail_price_amount = b.retail_price_amount;
    const retail_price_currency = b.retail_price_currency != null ? String(b.retail_price_currency).trim().toUpperCase() : '';
    const fx_rate_to_tzs = b.fx_rate_to_tzs;
    const priced_by = b.priced_by != null ? String(b.priced_by).trim().slice(0, 200) : null;
    const pricing_notes = b.pricing_notes != null ? String(b.pricing_notes).trim().slice(0, 2000) : null;

    const comp = computeMkopoFromRetailPrice({ retail_price_amount, fx_rate_to_tzs });
    if (!comp.ok) {
      return res.status(400).json({ success: false, error: comp.error || 'invalid_pricing' });
    }
    if (!retail_price_currency) {
      return res.status(400).json({ success: false, error: 'retail_price_currency is required' });
    }

    const now = new Date().toISOString();
    const patch = {
      retail_price_amount: Number(retail_price_amount),
      retail_price_currency,
      fx_rate_to_tzs: Number(fx_rate_to_tzs),
      retail_price_tzs: comp.retail_price_tzs,
      mkopo_max_loan_tzs: comp.mkopo_max_loan_tzs,
      mkopo_first_loan_tzs: comp.mkopo_first_loan_tzs,
      priced_by: priced_by || 'admin',
      priced_at: now,
      pricing_notes,
    };

    const { data: updated, error: uErr } = await supabase
      .from('mkopo_unsupported_device_reports')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (uErr) throw uErr;

    return res.json({ success: true, item: updated });
  } catch (err) {
    console.error('[mkopo_unsupported] pricing', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/borrowers/lookup-for-purge ──────────────────────────
// Search registrations directly (no confirmed-loan filter).
router.get('/borrowers/lookup-for-purge', async (req, res) => {
  try {
    const qRaw = req.query.search != null ? String(req.query.search).trim() : '';
    const q = qRaw.replace(/,/g, '');
    if (q.length < 2) {
      return res.status(400).json({ success: false, error: 'search must be at least 2 characters' });
    }

    const { data: rows, error } = await supabase
      .from('registrations')
      .select('borrower_id, full_name, phone, national_id, region, created_at')
      .or(
        [
          `borrower_id.ilike.%${q}%`,
          `full_name.ilike.%${q}%`,
          `phone.ilike.%${q}%`,
          `national_id.ilike.%${q}%`,
        ].join(','),
      )
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    return res.json({ success: true, matches: rows || [] });
  } catch (err) {
    console.error('[accounting:lookup-for-purge]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/borrowers ────────────────────────────────────────────
// Only borrowers whose LATEST loan has cash disbursement queue status = completed.
router.get('/borrowers', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const qRaw = req.query.search != null ? String(req.query.search).trim() : '';
    const from = (page - 1) * limit;

    // Latest loan per borrower (by created_at DESC). We'll later check queue completion for that loan.
    const { data: loanRows, error: loanErr } = await supabase
      .from('loans')
      .select('borrower_id, loan_id, created_at')
      .order('created_at', { ascending: false })
      .limit(8000);
    if (loanErr) throw loanErr;

    const seen = new Set();
    const orderedBorrowerIds = [];
    const latestLoanByBorrower = new Map();
    for (const row of loanRows || []) {
      const bid = row.borrower_id;
      if (!bid || seen.has(bid)) continue;
      seen.add(bid);
      orderedBorrowerIds.push(bid);
      if (row.loan_id) latestLoanByBorrower.set(bid, row.loan_id);
    }

    const latestLoanIds = [...new Set([...latestLoanByBorrower.values()].filter(Boolean))];
    const { data: completedRows, error: cErr } = await supabase
      .from('cash_disbursement_queue')
      .select('loan_id')
      .eq('status', 'completed')
      .in('loan_id', latestLoanIds);
    if (cErr) throw cErr;
    const completedLoanIds = new Set((completedRows || []).map((r) => r.loan_id).filter(Boolean));

    const customerSet = new Set(
      orderedBorrowerIds.filter((bid) => {
        const lid = latestLoanByBorrower.get(bid);
        return lid && completedLoanIds.has(lid);
      }),
    );
    const orderIndex = new Map(orderedBorrowerIds.map((id, i) => [id, i]));
    let candidateIds = orderedBorrowerIds.filter((id) => customerSet.has(id));
    if (qRaw) {
      const q = qRaw.replace(/,/g, '');
      const { data: nameRows, error: sErr } = await supabase
        .from('registrations')
        .select('borrower_id')
        .or(
          [
            `borrower_id.ilike.%${q}%`,
            `full_name.ilike.%${q}%`,
            `phone.ilike.%${q}%`,
            `national_id.ilike.%${q}%`,
          ].join(','),
        );
      if (sErr) throw sErr;
      const matched = [
        ...new Set(
          (nameRows || [])
            .map((r) => r.borrower_id)
            .filter((id) => id && customerSet.has(id)),
        ),
      ];
      matched.sort((a, b) => (orderIndex.get(a) - orderIndex.get(b)));
      candidateIds = matched;
    }

    const total = candidateIds.length;
    const pageIds = candidateIds.slice(from, from + limit);
    if (!pageIds.length) {
      return res.json({ success: true, borrowers: [], total: 0, page, limit });
    }

    const { data: rows, error } = await supabase
      .from('registrations')
      .select('*')
      .in('borrower_id', pageIds);
    if (error) throw error;

    const byId = Object.fromEntries((rows || []).map((r) => [r.borrower_id, r]));
    const borrowers = pageIds.map((id) => byId[id]).filter(Boolean);

    return res.json({
      success: true,
      borrowers,
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:borrowers]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/borrowers/:borrowerId ────────────────────────────────
router.get('/borrowers/:borrowerId', async (req, res) => {
  try {
    const borrowerId = req.params.borrowerId;
    const { data: reg, error: rErr } = await supabase
      .from('registrations')
      .select('*')
      .eq('borrower_id', borrowerId)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!reg) return res.status(404).json({ success: false, error: 'Borrower not found' });

    const { data: loans } = await supabase.from('loans').select('*').eq('borrower_id', borrowerId);
    return res.json({ success: true, registration: reg, loans: loans || [] });
  } catch (err) {
    console.error('[accounting:borrower-detail]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── PATCH /api/accounting/borrowers/:borrowerId ──────────────────────────────
router.patch('/borrowers/:borrowerId', async (req, res) => {
  try {
    const borrowerId = req.params.borrowerId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required for audited edits' });
    }

    const { data: before, error: bErr } = await supabase
      .from('registrations')
      .select('*')
      .eq('borrower_id', borrowerId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Borrower not found' });

    const allowed = ['full_name', 'phone', 'national_id', 'region', 'address'];
    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = String(req.body[k]).trim();
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, error: `Provide one of: ${allowed.join(', ')}` });
    }

    patch.updated_at = new Date().toISOString();
    const { data: after, error: uErr } = await supabase
      .from('registrations')
      .update(patch)
      .eq('borrower_id', borrowerId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'registration',
      entity_id: borrowerId,
      action: 'patch_registration',
      before,
      after,
      reason,
    });

    return res.json({ success: true, registration: after });
  } catch (err) {
    console.error('[accounting:patch-borrower]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

function isMissingRelationError(err, relationName) {
  const msg = String(err?.message || '');
  if (String(err?.code || '') === '42P01') return true;
  return relationName ? msg.toLowerCase().includes(`relation "${relationName}" does not exist`) : msg.toLowerCase().includes('does not exist');
}

async function safeDeleteIfTableExists(tableName, whereFn) {
  try {
    const q = supabase.from(tableName).delete();
    const res = await whereFn(q);
    if (res?.error) throw res.error;
    return { ok: true };
  } catch (err) {
    if (isMissingRelationError(err, tableName)) return { ok: true, skipped: true, skipped_reason: 'missing_table' };
    throw err;
  }
}

// ── POST /api/accounting/borrowers/:borrowerId/purge ─────────────────────────
router.post('/borrowers/:borrowerId/purge', async (req, res) => {
  try {
    const borrowerId = String(req.params.borrowerId || '').trim();
    const actor = req.body?.actor != null ? String(req.body.actor).trim() : '';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    const confirmBorrowerId = req.body?.confirm_borrower_id != null ? String(req.body.confirm_borrower_id).trim() : '';

    if (!borrowerId) return res.status(400).json({ success: false, error: 'borrowerId is required' });
    if (!actor) return res.status(400).json({ success: false, error: 'actor is required' });
    if (!reason) return res.status(400).json({ success: false, error: 'reason is required' });
    if (confirmBorrowerId !== borrowerId) {
      return res.status(400).json({ success: false, error: 'confirm_borrower_id must exactly match borrowerId' });
    }

    const { data: reg, error: rErr } = await supabase
      .from('registrations')
      .select('*')
      .eq('borrower_id', borrowerId)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!reg) return res.status(404).json({ success: false, error: 'Borrower not found' });

    const { data: loans, error: lErr } = await supabase
      .from('loans')
      .select('loan_id, borrower_id, principal_amount, outstanding_amount, disbursed_at, cash_disbursement_confirmed_at')
      .eq('borrower_id', borrowerId);
    if (lErr) throw lErr;

    const loanIds = [...new Set((loans || []).map((l) => l.loan_id).filter(Boolean))];

    const snapshot = {
      borrower_id: borrowerId,
      registration: {
        full_name: reg.full_name,
        phone: reg.phone,
        national_id: reg.national_id,
        region: reg.region,
        address: reg.address,
        created_at: reg.created_at,
      },
      loans: (loans || []).map((l) => ({
        loan_id: l.loan_id,
        principal_amount: l.principal_amount,
        outstanding_amount: l.outstanding_amount,
        disbursed_at: l.disbursed_at,
        cash_disbursement_confirmed_at: l.cash_disbursement_confirmed_at,
      })),
    };

    await logAccountingAudit({
      actor,
      entity_type: 'borrower',
      entity_id: borrowerId,
      action: 'borrower_purge_start',
      before: snapshot,
      after: null,
      reason,
    });

    // Children first. For optional tables, treat missing relation as a skip.
    await safeDeleteIfTableExists('contract_acceptances', (q) => q.eq('borrower_id', borrowerId));

    await safeDeleteIfTableExists('payment_references', (q) => q.eq('borrower_id', borrowerId));

    if (loanIds.length) {
      await safeDeleteIfTableExists('payments', (q) => q.in('loan_id', loanIds));
    } else {
      await safeDeleteIfTableExists('payments', (q) => q.eq('borrower_id', borrowerId));
    }

    await safeDeleteIfTableExists('notifications_log', (q) => q.eq('borrower_id', borrowerId));
    await safeDeleteIfTableExists('tamper_logs', (q) => q.eq('borrower_id', borrowerId));

    if (loanIds.length) {
      await safeDeleteIfTableExists('loan_invoices', (q) => q.in('loan_id', loanIds));
      await safeDeleteIfTableExists('cash_disbursement_queue', (q) => q.in('loan_id', loanIds));
      await safeDeleteIfTableExists('loan_requests', (q) => q.in('loan_id', loanIds));
    } else {
      await safeDeleteIfTableExists('loan_invoices', (q) => q.eq('borrower_id', borrowerId));
      await safeDeleteIfTableExists('cash_disbursement_queue', (q) => q.eq('borrower_id', borrowerId));
      await safeDeleteIfTableExists('loan_requests', (q) => q.eq('borrower_id', borrowerId));
    }

    await safeDeleteIfTableExists('devices', (q) => q.eq('borrower_id', borrowerId));

    // Preserve raw till/SMS history: unclaim links to the borrower/loan.
    const { error: unclaimErr } = await supabase
      .from('lipa_transactions')
      .update({
        claimed_borrower_id: null,
        claimed_loan_id: null,
        claimed_at: null,
        payment_reference_id: null,
      })
      .eq('claimed_borrower_id', borrowerId);
    if (unclaimErr) throw unclaimErr;

    await safeDeleteIfTableExists('loans', (q) => q.eq('borrower_id', borrowerId));
    await safeDeleteIfTableExists('registrations', (q) => q.eq('borrower_id', borrowerId));

    await logAccountingAudit({
      actor,
      entity_type: 'borrower',
      entity_id: borrowerId,
      action: 'borrower_purge_complete',
      before: snapshot,
      after: { borrower_id: borrowerId, purged_loan_ids: loanIds, loans_count: loanIds.length },
      reason,
    });

    return res.json({ success: true, borrower_id: borrowerId, purged_loan_ids: loanIds });
  } catch (err) {
    console.error('[accounting:purge-borrower]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/loans ────────────────────────────────────────────────
router.get('/loans', async (req, res) => {
  try {
    const { device_status, page = 1, limit = 50, search } = req.query;
    const from = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const to = from + parseInt(limit, 10) - 1;

    let query = supabase.from('loans').select('*', { count: 'exact' });
    if (device_status && device_status !== 'all') query = query.eq('device_status', device_status);

    const qRaw = search != null ? String(search).trim() : '';
    if (qRaw) {
      const q = qRaw.replace(/,/g, '');
      const { data: nameRows } = await supabase
        .from('registrations')
        .select('borrower_id')
        .ilike('full_name', `%${q}%`);
      const nameBorrowerIds = [...new Set((nameRows || []).map((r) => r.borrower_id).filter(Boolean))];
      const orParts = [`loan_id.ilike.%${q}%`, `borrower_id.ilike.%${q}%`];
      if (nameBorrowerIds.length) {
        orParts.push(`borrower_id.in.(${quoteBorrowerIdsForInFilter(nameBorrowerIds).join(',')})`);
      }
      query = query.or(orParts.join(','));
    }

    const { data: loans, error, count } = await query
      .order('next_due_date', { ascending: true, nullsFirst: false })
      .range(from, to);
    if (error) throw error;

    const loanBorrowerIds = [...new Set((loans || []).map((l) => l.borrower_id).filter(Boolean))];
    let loanNameByBorrower = {};
    if (loanBorrowerIds.length) {
      const { data: regs } = await supabase
        .from('registrations')
        .select('borrower_id, full_name')
        .in('borrower_id', loanBorrowerIds);
      loanNameByBorrower = Object.fromEntries((regs || []).map((r) => [r.borrower_id, r.full_name]));
    }

    const loanIdList = (loans || []).map((l) => l.loan_id);
    let invByLoan = {};
    if (loanIdList.length) {
      const { data: invRows } = await supabase
        .from('loan_invoices')
        .select('loan_id, status, due_date')
        .in('loan_id', loanIdList);
      for (const r of invRows || []) {
        if (!invByLoan[r.loan_id]) invByLoan[r.loan_id] = [];
        invByLoan[r.loan_id].push(r);
      }
    }

    return res.json({
      success: true,
      loans: (loans || []).map((l) => ({
        ...l,
        borrower_full_name: loanNameByBorrower[l.borrower_id] || null,
        invoice_summary: summarizeInvoiceRows(invByLoan[l.loan_id] || []),
      })),
      total: count || 0,
      page: parseInt(page, 10),
    });
  } catch (err) {
    console.error('[accounting:loans]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/accounting/loans/pending-disbursement (before :loanId route) ───
router.get('/loans/pending-disbursement', async (req, res) => {
  try {
    const { data: queueRows, error: qErr } = await supabase
      .from('cash_disbursement_queue')
      .select('loan_id, borrower_id, enqueued_at, phone, principal_amount')
      .eq('status', 'pending')
      .order('enqueued_at', { ascending: true })
      .limit(500);
    if (qErr) throw qErr;

    const loanIds = [...new Set((queueRows || []).map((r) => r.loan_id).filter(Boolean))];
    if (!loanIds.length) {
      return res.json({ success: true, stage: 'customers', loans: [], count: 0 });
    }

    const { data: loans, error } = await supabase
      .from('loans')
      .select('*')
      .in('loan_id', loanIds)
      .is('repaid_at', null)
      .gt('outstanding_amount', 0);
    if (error) throw error;

    const loanById = Object.fromEntries((loans || []).map((l) => [l.loan_id, l]));
    const orderedLoans = [];
    for (const q of queueRows || []) {
      const l = loanById[q.loan_id];
      if (l) orderedLoans.push({ loan: l, queue: q });
    }

    const borrowerIdsForFilter = [...new Set(orderedLoans.map((x) => x.loan.borrower_id).filter(Boolean))];
    let nameByBorrowerForFilter = {};
    if (borrowerIdsForFilter.length) {
      const { data: regsF } = await supabase
        .from('registrations')
        .select('borrower_id, full_name, phone')
        .in('borrower_id', borrowerIdsForFilter);
      nameByBorrowerForFilter = Object.fromEntries((regsF || []).map((r) => [r.borrower_id, r]));
    }
    const blockedSet = await getBlockedCanonicalPhoneSet();
    const filteredOrdered = [];
    for (const item of orderedLoans) {
      const q = item.queue;
      const l = item.loan;
      const regPhone = nameByBorrowerForFilter[l.borrower_id]?.phone;
      const raw =
        (q.phone != null && String(q.phone).trim()) || (regPhone && String(regPhone).trim()) || '';
      const canon = normalizePhone(raw);
      if (canon && blockedSet.has(canon)) continue;
      filteredOrdered.push(item);
    }

    const outLoanIds = filteredOrdered.map((x) => x.loan.loan_id);
    let deviceByLoan = {};
    if (outLoanIds.length) {
      const { data: devices, error: dErr } = await supabase
        .from('devices')
        .select('loan_id, mdm_compliance, protection_first_completed_at')
        .in('loan_id', outLoanIds);
      if (dErr) throw dErr;
      deviceByLoan = Object.fromEntries((devices || []).map((d) => [d.loan_id, d]));
    }

    const nameByBorrower = nameByBorrowerForFilter;

    const enriched = filteredOrdered.map(({ loan: l, queue: q }) => {
      const dev = deviceByLoan[l.loan_id] || null;
      const mdm = dev?.mdm_compliance && typeof dev.mdm_compliance === 'object' ? dev.mdm_compliance : null;
      const allOk = mdm?.all_required_ok === true;
      const okCount = Number.isFinite(mdm?.ok_count) ? Number(mdm.ok_count) : null;
      const requiredCount = Number.isFinite(mdm?.required_count) ? Number(mdm.required_count) : null;
      return {
        ...l,
        borrower_full_name: nameByBorrower[l.borrower_id]?.full_name || null,
        borrower_phone: nameByBorrower[l.borrower_id]?.phone || null,
        queue_phone: q.phone != null ? String(q.phone) : null,
        queue_principal_amount: q.principal_amount != null ? Number(q.principal_amount) : null,
        queue_enqueued_at: q.enqueued_at || null,
        is_customer: !!dev?.protection_first_completed_at,
        protection_all_required_ok: allOk,
        protection_ok_count: okCount,
        protection_required_count: requiredCount,
      };
    });

    return res.json({
      success: true,
      stage: 'customers',
      loans: enriched,
      count: enriched.length,
    });
  } catch (err) {
    console.error('[accounting:pending-disbursement]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── Disbursement phone blocklist (canonical 255… MSISDN; same rules as loan registration) ──
router.get('/disbursement-blocklist', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('disbursement_phone_blocklist')
      .select('id, phone_canonical, note, created_at')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) throw error;
    return res.json({ success: true, entries: data || [] });
  } catch (err) {
    console.error('[accounting:disbursement-blocklist:get]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

router.post('/disbursement-blocklist', async (req, res) => {
  try {
    const raw = req.body?.phone != null ? String(req.body.phone).trim() : '';
    const note = req.body?.note != null ? String(req.body.note).trim() : null;
    const phone_canonical = normalizePhone(raw);
    if (!phone_canonical) {
      return res.status(400).json({
        success: false,
        error: 'Valid Tanzania phone required (07XXXXXXXX or 255XXXXXXXXX).',
      });
    }
    const { data, error } = await supabase
      .from('disbursement_phone_blocklist')
      .insert({ phone_canonical, note: note || null })
      .select()
      .single();
    if (error) {
      if (String(error.code) === '23505') {
        return res.status(409).json({ success: false, error: 'Phone already on blocklist.' });
      }
      throw error;
    }
    return res.json({ success: true, entry: data });
  } catch (err) {
    console.error('[accounting:disbursement-blocklist:post]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

router.delete('/disbursement-blocklist', async (req, res) => {
  try {
    const raw = req.query.phone != null ? String(req.query.phone).trim() : '';
    const phone_canonical = normalizePhone(raw);
    if (!phone_canonical) {
      return res.status(400).json({
        success: false,
        error: 'Query ?phone= with valid Tanzania MSISDN required.',
      });
    }
    const { error } = await supabase
      .from('disbursement_phone_blocklist')
      .delete()
      .eq('phone_canonical', phone_canonical);
    if (error) throw error;
    return res.json({ success: true, removed: phone_canonical });
  } catch (err) {
    console.error('[accounting:disbursement-blocklist:delete]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/confirm-cash-disbursement ─────────────
router.post('/loans/:loanId/confirm-cash-disbursement', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor != null ? String(req.body.actor).trim() : '';
    const notes = req.body?.notes != null ? String(req.body.notes).trim() : '';
    if (!actor) {
      return res.status(400).json({ success: false, error: 'actor is required' });
    }

    const { data: before, error: bErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Loan not found' });

    if (before.cash_disbursement_confirmed_at) {
      await supabase
        .from('cash_disbursement_queue')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('loan_id', loanId)
        .eq('status', 'pending');
      return res.json({ success: true, loan: before, idempotent: true });
    }

    const { data: queuePhoneRow } = await supabase
      .from('cash_disbursement_queue')
      .select('phone')
      .eq('loan_id', loanId)
      .maybeSingle();
    let phoneForBlock = queuePhoneRow?.phone;
    if (!phoneForBlock || !String(phoneForBlock).trim()) {
      const { data: regR } = await supabase
        .from('registrations')
        .select('phone')
        .eq('borrower_id', before.borrower_id)
        .maybeSingle();
      phoneForBlock = regR?.phone;
    }
    if (!phoneForBlock || !String(phoneForBlock).trim()) {
      const { data: devR } = await supabase
        .from('devices')
        .select('mpesa_phone')
        .eq('loan_id', loanId)
        .maybeSingle();
      phoneForBlock = devR?.mpesa_phone;
    }
    if (await isPhoneBlockedForDisbursement(phoneForBlock)) {
      return res.status(409).json({
        success: false,
        error: 'This phone number is blocked for cash disbursement.',
      });
    }

    const ts = new Date().toISOString();
    const patch = {
      cash_disbursement_confirmed_at: ts,
      cash_disbursement_confirmed_by: actor.slice(0, 200),
      cash_disbursement_notes: notes || null,
      updated_at: ts,
    };
    if (!before.disbursed_at) patch.disbursed_at = ts;

    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update(patch)
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'cash_disbursement_confirm',
      before,
      after,
      reason: notes || 'Cash disbursement confirmed (principal sent to borrower)',
    });

    await supabase
      .from('cash_disbursement_queue')
      .update({ status: 'completed', updated_at: ts })
      .eq('loan_id', loanId)
      .eq('status', 'pending');

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:confirm-disbursement]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/close-loan (audited) ──────────────────
// Ops-only safety valve: mark a loan as repaid when outstanding_amount is 0 and all invoices are paid.
router.post('/loans/:loanId/close-loan', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }

    const { data: loan, error: lErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (lErr) throw lErr;
    if (!loan) return res.status(404).json({ success: false, error: 'Loan not found' });

    const { data: invs, error: iErr } = await supabase
      .from('loan_invoices')
      .select('status')
      .eq('loan_id', loanId)
      .limit(2000);
    if (iErr) throw iErr;

    const outstanding = Number(loan.outstanding_amount || 0);
    const anyUnpaid = (invs || []).some((r) => r.status === 'pending' || r.status === 'overdue');
    if (outstanding > 0 || anyUnpaid) {
      return res.status(409).json({
        success: false,
        error: 'Loan is not eligible to close: outstanding_amount must be 0 and all invoices must be paid.',
      });
    }

    const before = { ...loan };
    const ts = new Date().toISOString();
    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update({ repaid_at: loan.repaid_at || ts, updated_at: ts })
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'close_loan',
      before,
      after,
      reason,
    });

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:close-loan]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/loans/:loanId ────────────────────────────────────────
router.get('/loans/:loanId', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const { data: loan, error: loanErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (loanErr) throw loanErr;
    if (!loan) return res.status(404).json({ success: false, error: 'Loan not found' });

    const [{ data: invoices, error: invErr }, { data: registration }] = await Promise.all([
      supabase.from('loan_invoices').select('*').eq('loan_id', loanId).order('installment_index', { ascending: true }),
      supabase.from('registrations').select('*').eq('borrower_id', loan.borrower_id).maybeSingle(),
    ]);
    if (invErr) throw invErr;

    return res.json({
      success: true,
      loan,
      registration: registration || null,
      invoices: invoices || [],
      invoice_summary: summarizeInvoiceRows(invoices || []),
    });
  } catch (err) {
    console.error('[accounting:loan-detail]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/invoices/:invoiceId/adjust ──────────
router.post('/loans/:loanId/invoices/:invoiceId/adjust', async (req, res) => {
  try {
    const { loanId, invoiceId } = req.params;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    const status = req.body?.status != null ? String(req.body.status).trim() : '';
    const valid = ['pending', 'paid', 'overdue'];
    if (!valid.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of: ${valid.join(', ')}` });
    }

    const { data: inv, error: iErr } = await supabase
      .from('loan_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('loan_id', loanId)
      .maybeSingle();
    if (iErr) throw iErr;
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found for this loan' });

    const before = { ...inv };
    const updates = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (status === 'paid') {
      updates.paid_at = req.body.paid_at ? new Date(req.body.paid_at).toISOString() : new Date().toISOString();
    } else {
      updates.paid_at = null;
    }

    const { data: after, error: uErr } = await supabase
      .from('loan_invoices')
      .update(updates)
      .eq('id', inv.id)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan_invoice',
      entity_id: invoiceId,
      action: 'adjust_invoice_status',
      before,
      after,
      reason,
    });

    return res.json({ success: true, invoice: after });
  } catch (err) {
    console.error('[accounting:invoice-adjust]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/invoices/:invoiceId/adjust-fields ──────
router.post('/loans/:loanId/invoices/:invoiceId/adjust-fields', async (req, res) => {
  try {
    const { loanId, invoiceId } = req.params;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }

    const patch = {};
    if (req.body?.amount_due !== undefined) {
      const raw = req.body?.amount_due;
      if (raw === null || Number.isNaN(Number(raw))) {
        return res.status(400).json({ success: false, error: 'amount_due must be a number' });
      }
      const v = Number(raw);
      if (v < 0) return res.status(400).json({ success: false, error: 'amount_due must be >= 0' });
      patch.amount_due = v;
    }
    if (req.body?.due_date !== undefined) {
      const raw = req.body?.due_date;
      const d = new Date(raw);
      if (!raw || Number.isNaN(d.getTime())) {
        return res.status(400).json({ success: false, error: 'due_date must be a valid date string' });
      }
      patch.due_date = d.toISOString();
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ success: false, error: 'Provide amount_due and/or due_date' });
    }
    patch.updated_at = new Date().toISOString();

    const { data: inv, error: iErr } = await supabase
      .from('loan_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('loan_id', loanId)
      .maybeSingle();
    if (iErr) throw iErr;
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found for this loan' });

    const before = { ...inv };
    const { data: after, error: uErr } = await supabase
      .from('loan_invoices')
      .update(patch)
      .eq('id', inv.id)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan_invoice',
      entity_id: invoiceId,
      action: 'adjust_invoice_fields',
      before,
      after,
      reason,
    });

    return res.json({ success: true, invoice: after });
  } catch (err) {
    console.error('[accounting:invoice-adjust-fields]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/invoices/:invoiceId/delete ─────────────
router.post('/loans/:loanId/invoices/:invoiceId/delete', async (req, res) => {
  try {
    const { loanId, invoiceId } = req.params;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }

    const { data: inv, error: iErr } = await supabase
      .from('loan_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('loan_id', loanId)
      .maybeSingle();
    if (iErr) throw iErr;
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found for this loan' });

    const before = { ...inv };
    const { error: dErr } = await supabase.from('loan_invoices').delete().eq('id', inv.id);
    if (dErr) throw dErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan_invoice',
      entity_id: invoiceId,
      action: 'delete_invoice',
      before,
      after: null,
      reason,
    });

    return res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('[accounting:invoice-delete]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/adjust-outstanding ────────────────────
router.post('/loans/:loanId/adjust-outstanding', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    const raw = req.body?.outstanding_amount;
    if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
      return res.status(400).json({ success: false, error: 'outstanding_amount (number) is required' });
    }
    const outstanding_amount = Number(raw);
    if (outstanding_amount < 0) {
      return res.status(400).json({ success: false, error: 'outstanding_amount must be >= 0' });
    }

    const { data: before, error: bErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Loan not found' });

    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update({
        outstanding_amount,
        updated_at: new Date().toISOString(),
      })
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'adjust_outstanding',
      before,
      after,
      reason,
    });

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:outstanding-adjust]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/adjust-principal ───────────────────────
router.post('/loans/:loanId/adjust-principal', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    const raw = req.body?.principal_amount;
    if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
      return res.status(400).json({ success: false, error: 'principal_amount (number) is required' });
    }
    const principal_amount = Number(raw);
    if (principal_amount < 0) {
      return res.status(400).json({ success: false, error: 'principal_amount must be >= 0' });
    }

    const { data: before, error: bErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Loan not found' });

    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update({
        principal_amount,
        updated_at: new Date().toISOString(),
      })
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'adjust_principal',
      before,
      after,
      reason,
    });

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:principal-adjust]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/adjust-total-repayment ────────────────
router.post('/loans/:loanId/adjust-total-repayment', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    const raw = req.body?.total_repayment_amount;
    if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
      return res.status(400).json({ success: false, error: 'total_repayment_amount (number) is required' });
    }
    const total_repayment_amount = Number(raw);
    if (total_repayment_amount < 0) {
      return res.status(400).json({ success: false, error: 'total_repayment_amount must be >= 0' });
    }

    const { data: before, error: bErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Loan not found' });

    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update({
        total_repayment_amount,
        updated_at: new Date().toISOString(),
      })
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'adjust_total_repayment',
      before,
      after,
      reason,
    });

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:total-repayment-adjust]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/adjust (principal/outstanding) ─────────
router.post('/loans/:loanId/adjust', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }

    const patch = {};
    if (req.body?.principal_amount !== undefined) {
      const raw = req.body?.principal_amount;
      if (raw === null || Number.isNaN(Number(raw))) {
        return res.status(400).json({ success: false, error: 'principal_amount must be a number' });
      }
      const v = Number(raw);
      if (v < 0) return res.status(400).json({ success: false, error: 'principal_amount must be >= 0' });
      patch.principal_amount = v;
    }
    if (req.body?.outstanding_amount !== undefined) {
      const raw = req.body?.outstanding_amount;
      if (raw === null || Number.isNaN(Number(raw))) {
        return res.status(400).json({ success: false, error: 'outstanding_amount must be a number' });
      }
      const v = Number(raw);
      if (v < 0) return res.status(400).json({ success: false, error: 'outstanding_amount must be >= 0' });
      patch.outstanding_amount = v;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ success: false, error: 'Provide principal_amount and/or outstanding_amount' });
    }

    const { data: before, error: bErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Loan not found' });

    patch.updated_at = new Date().toISOString();
    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update(patch)
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'adjust_loan_fields',
      before,
      after,
      reason,
    });

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:loan-adjust]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/cash-receipts/lipa (read-only; Lipa = borrower cash-in) ─
router.get('/cash-receipts/lipa', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const claim = String(req.query.claim || 'all').toLowerCase();
    const qRaw = req.query.search != null ? String(req.query.search).trim() : '';
    const q = qRaw.replace(/,/g, '').replace(/%/g, '').replace(/_/g, '').slice(0, 120);

    let query = supabase.from('lipa_transactions').select('*', { count: 'exact' });
    if (claim === 'unclaimed') query = query.is('claimed_borrower_id', null);
    else if (claim === 'claimed') query = query.not('claimed_borrower_id', 'is', null);

    if (q) {
      const pat = `%${q}%`;
      query = query.or(
        [
          `transaction_ref.ilike.${pat}`,
          `payer_phone.ilike.${pat}`,
          `claimed_loan_id.ilike.${pat}`,
          `claimed_borrower_id.ilike.${pat}`,
        ].join(','),
      );
    }

    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const { data: rows, error, count } = await query
      .order('transaction_occurred_at', { ascending: false, nullsFirst: false })
      .order('ingested_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      transactions: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:lipa-list]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/collections — Lipa-only rollups (ingested_at window)
router.get('/reports/collections', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from).toISOString() : null;
    const to = req.query.to ? new Date(req.query.to).toISOString() : null;
    if (!from || !to || Number.isNaN(new Date(from).getTime()) || Number.isNaN(new Date(to).getTime())) {
      return res.status(400).json({ success: false, error: 'from and to (ISO dates) are required' });
    }
    const format = String(req.query.format || 'json').toLowerCase();

    const { data: rows, error } = await supabase
      .from('lipa_transactions')
      .select('amount, ingested_at, transaction_ref, claimed_loan_id, claimed_borrower_id, payer_phone, transaction_occurred_at')
      .gte('ingested_at', from)
      .lte('ingested_at', to)
      .limit(50000);
    if (error) throw error;

    const list = rows || [];
    let totalAmount = 0;
    let claimedCount = 0;
    let unclaimedCount = 0;
    let lipaOnCompleteLoans = 0;
    let confirmedSet = new Set();
    try {
      confirmedSet = await fetchConfirmedLoanIdsSet();
    } catch (_) {
      /* columns may not exist before migration */
    }
    for (const r of list) {
      totalAmount += Number(r.amount) || 0;
      if (r.claimed_borrower_id) claimedCount++;
      else unclaimedCount++;
      const lid = r.claimed_loan_id != null ? String(r.claimed_loan_id) : '';
      if (lid && confirmedSet.has(lid)) lipaOnCompleteLoans += Number(r.amount) || 0;
    }

    const summary = {
      basis: 'lipa_transactions.ingested_at',
      from,
      to,
      row_count: list.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      lipa_amount_on_complete_loans: Math.round(lipaOnCompleteLoans * 100) / 100,
      note:
        'total_amount is all ingested Lipa; lipa_amount_on_complete_loans sums rows whose claimed_loan_id has cashier confirmation (complete book).',
      claimed_rows: claimedCount,
      unclaimed_rows: unclaimedCount,
    };

    if (format === 'csv') {
      const header = toCsvRow([
        'ingested_at',
        'amount',
        'transaction_ref',
        'payer_phone',
        'claimed_loan_id',
        'claimed_borrower_id',
      ]);
      const lines = [header];
      for (const r of list) {
        lines.push(
          toCsvRow([
            r.ingested_at,
            r.amount,
            r.transaction_ref,
            r.payer_phone,
            r.claimed_loan_id,
            r.claimed_borrower_id,
          ]),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="collections-lipa.csv"');
      return res.send(lines.join('\n'));
    }

    return res.json({
      success: true,
      summary,
      rows: list,
      definition: { complete_loans_only_metric: 'lipa_amount_on_complete_loans' },
    });
  } catch (err) {
    console.error('[accounting:collections]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/aging ────────────────────────────────────────
router.get('/reports/aging', async (req, res) => {
  try {
    const format = String(req.query.format || 'json').toLowerCase();
    const incAll = includeIncompleteLoans(req);
    const { data: invoices, error } = await supabase
      .from('loan_invoices')
      .select('id, loan_id, borrower_id, invoice_number, amount_due, due_date, status')
      .in('status', ['pending', 'overdue']);
    if (error) throw error;

    let invList = invoices || [];
    if (!incAll) {
      const confirmedSet = await fetchConfirmedLoanIdsSet();
      invList = invList.filter((inv) => confirmedSet.has(inv.loan_id));
    }

    const now = Date.now();
    const dayMs = 86400000;
    const buckets = {
      upcoming: { label: 'Not yet due', amount: 0, count: 0 },
      days_1_30: { label: '1–30 days past due', amount: 0, count: 0 },
      days_31_60: { label: '31–60 days past due', amount: 0, count: 0 },
      days_61_90: { label: '61–90 days past due', amount: 0, count: 0 },
      days_90_plus: { label: '90+ days past due', amount: 0, count: 0 },
    };

    for (const inv of invList) {
      const due = new Date(inv.due_date).getTime();
      const amt = Number(inv.amount_due) || 0;
      if (due > now) {
        buckets.upcoming.amount += amt;
        buckets.upcoming.count++;
        continue;
      }
      const daysPast = Math.floor((now - due) / dayMs);
      if (daysPast <= 30) {
        buckets.days_1_30.amount += amt;
        buckets.days_1_30.count++;
      } else if (daysPast <= 60) {
        buckets.days_31_60.amount += amt;
        buckets.days_31_60.count++;
      } else if (daysPast <= 90) {
        buckets.days_61_90.amount += amt;
        buckets.days_61_90.count++;
      } else {
        buckets.days_90_plus.amount += amt;
        buckets.days_90_plus.count++;
      }
    }

    const totalReceivable = Object.values(buckets).reduce((s, b) => s + b.amount, 0);

    if (format === 'csv') {
      const lines = [toCsvRow(['bucket', 'label', 'count', 'amount'])];
      for (const [key, b] of Object.entries(buckets)) {
        lines.push(toCsvRow([key, b.label, b.count, Math.round(b.amount * 100) / 100]));
      }
      lines.push(toCsvRow(['total', 'All buckets', '', Math.round(totalReceivable * 100) / 100]));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ar-aging.csv"');
      return res.send(lines.join('\n'));
    }

    return res.json({
      success: true,
      generated_at: new Date().toISOString(),
      definition: {
        complete_loans_only: !incAll,
        include_incomplete: incAll,
      },
      buckets,
      total_receivable: Math.round(totalReceivable * 100) / 100,
    });
  } catch (err) {
    console.error('[accounting:aging]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

/**
 * PAR (Portfolio at Risk): balance-weighted % of gross portfolio with worst unpaid installment
 * at least N days past due (as of `asOf`). Numerator = full loans.outstanding_amount for those loans.
 * Denominator = sum(outstanding_amount) for all loans with outstanding_amount > 0.
 */
// ── GET /api/accounting/reports/par?asOf=ISO ───────────────────────────────
router.get('/reports/par', async (req, res) => {
  try {
    const incAll = includeIncompleteLoans(req);
    const asOfRaw = req.query.asOf != null ? String(req.query.asOf).trim() : '';
    const asOf = asOfRaw ? new Date(asOfRaw) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid asOf date' });
    }
    const asOfMs = asOf.getTime();
    const dayMs = 86400000;

    let loanQuery = supabase
      .from('loans')
      .select('loan_id, borrower_id, outstanding_amount, device_status')
      .gt('outstanding_amount', 0);
    if (!incAll) {
      const confirmedSet = await fetchConfirmedLoanIdsSet();
      const confirmedIds = [...confirmedSet];
      if (!confirmedIds.length) {
        return res.json({
          success: true,
          as_of: asOf.toISOString(),
          definition: {
            complete_loans_only: true,
            include_incomplete: false,
            denominator: 'No completed loans in cash_disbursement_queue.',
            numerator:
              'For each such loan, max days past due = longest delay among pending/overdue installments with due_date < asOf. If max >= N, add full loan outstanding to PARn balance.',
            par_pct: 'PARn balance / denominator * 100',
          },
          portfolio_gross_outstanding: 0,
          par: { par1: { balance: 0, pct: 0 }, par30: { balance: 0, pct: 0 }, par90: { balance: 0, pct: 0 } },
          loan_count_in_par30: 0,
        });
      }
      loanQuery = loanQuery.in('loan_id', confirmedIds);
    }
    const { data: loans, error: le } = await loanQuery;
    if (le) throw le;

    const { data: invs, error: ie } = await supabase
      .from('loan_invoices')
      .select('loan_id, due_date, status')
      .in('status', ['pending', 'overdue']);
    if (ie) throw ie;

    const loanIdSet = new Set((loans || []).map((l) => l.loan_id));
    /** @type {Map<string, number>} max calendar days past due for any unpaid installment */
    const loanMaxDaysPast = new Map();
    for (const inv of invs || []) {
      if (!incAll && !loanIdSet.has(inv.loan_id)) continue;
      const due = new Date(inv.due_date).getTime();
      if (due >= asOfMs) continue;
      const daysPast = Math.floor((asOfMs - due) / dayMs);
      const cur = loanMaxDaysPast.get(inv.loan_id) || 0;
      loanMaxDaysPast.set(inv.loan_id, Math.max(cur, daysPast));
    }

    let portfolioGross = 0;
    let balancePar1 = 0;
    let balancePar30 = 0;
    let balancePar90 = 0;
    const loanIdsPar30 = [];

    for (const l of loans || []) {
      const o = Number(l.outstanding_amount) || 0;
      if (o <= 0) continue;
      portfolioGross += o;
      const maxD = loanMaxDaysPast.get(l.loan_id) || 0;
      if (maxD >= 1) balancePar1 += o;
      if (maxD >= 30) {
        balancePar30 += o;
        loanIdsPar30.push(l.loan_id);
      }
      if (maxD >= 90) balancePar90 += o;
    }

    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

    return res.json({
      success: true,
      as_of: asOf.toISOString(),
      definition: {
        complete_loans_only: !incAll,
        include_incomplete: incAll,
        denominator:
          incAll
            ? 'Sum of loans.outstanding_amount for all loans with outstanding_amount > 0.'
            : 'Same, but only loans with cash_disbursement_queue.status = completed (cashier completed disbursement).',
        numerator:
          'For each such loan, max days past due = longest delay among pending/overdue installments with due_date < asOf. If max >= N, add full loan outstanding to PARn balance.',
        par_pct: 'PARn balance / denominator * 100',
      },
      portfolio_gross_outstanding: Math.round(portfolioGross * 100) / 100,
      par: {
        par1: { balance: Math.round(balancePar1 * 100) / 100, pct: pct(balancePar1, portfolioGross) },
        par30: { balance: Math.round(balancePar30 * 100) / 100, pct: pct(balancePar30, portfolioGross) },
        par90: { balance: Math.round(balancePar90 * 100) / 100, pct: pct(balancePar90, portfolioGross) },
      },
      loan_count_in_par30: loanIdsPar30.length,
    });
  } catch (err) {
    console.error('[accounting:par]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

/**
 * Expected = sum(amount_due) for installments with due_date in [from,to].
 * Actual = sum(lipa_transactions.amount) with ingested_at in [from,to] (borrower cash-in truth).
 * Per-loan: expected from invoices; actual from Lipa rows with claimed_loan_id.
 */
// ── GET /api/accounting/reports/expected-vs-actual ─────────────────────────
router.get('/reports/expected-vs-actual', async (req, res) => {
  try {
    const incAll = includeIncompleteLoans(req);
    const from = req.query.from ? new Date(req.query.from).toISOString() : null;
    const to = req.query.to ? new Date(req.query.to).toISOString() : null;
    if (!from || !to || Number.isNaN(new Date(from).getTime()) || Number.isNaN(new Date(to).getTime())) {
      return res.status(400).json({ success: false, error: 'from and to (ISO dates) are required' });
    }
    const format = String(req.query.format || 'json').toLowerCase();

    const confirmedSet = incAll ? null : await fetchConfirmedLoanIdsSet();

    const { data: invs, error: ie } = await supabase
      .from('loan_invoices')
      .select('loan_id, borrower_id, amount_due, due_date, status, installment_index')
      .gte('due_date', from)
      .lte('due_date', to)
      .limit(100000);
    if (ie) throw ie;

    let expectedTotal = 0;
    const expectedByLoan = new Map();
    for (const inv of invs || []) {
      if (!incAll && !confirmedSet.has(inv.loan_id)) continue;
      const a = Number(inv.amount_due) || 0;
      expectedTotal += a;
      const lid = inv.loan_id;
      expectedByLoan.set(lid, (expectedByLoan.get(lid) || 0) + a);
    }

    const { data: lipaRows, error: le } = await supabase
      .from('lipa_transactions')
      .select('amount, claimed_loan_id, ingested_at, transaction_ref')
      .gte('ingested_at', from)
      .lte('ingested_at', to)
      .limit(50000);
    if (le) throw le;

    let actualTotal = 0;
    const actualByLoan = new Map();
    for (const row of lipaRows || []) {
      const lid = row.claimed_loan_id;
      if (!incAll && lid && !confirmedSet.has(lid)) continue;
      const a = Number(row.amount) || 0;
      actualTotal += a;
      if (lid) {
        actualByLoan.set(lid, (actualByLoan.get(lid) || 0) + a);
      }
    }

    const allLoanIds = new Set([...expectedByLoan.keys(), ...actualByLoan.keys()]);
    const perLoan = [];
    for (const loanId of allLoanIds) {
      const exp = expectedByLoan.get(loanId) || 0;
      const act = actualByLoan.get(loanId) || 0;
      perLoan.push({
        loan_id: loanId,
        expected_due_in_period: Math.round(exp * 100) / 100,
        lipa_claimed_in_period: Math.round(act * 100) / 100,
        shortfall: Math.round((exp - act) * 100) / 100,
      });
    }
    perLoan.sort((a, b) => Math.abs(b.shortfall) - Math.abs(a.shortfall));

    const summary = {
      complete_loans_only: !incAll,
      basis_expected: 'loan_invoices.due_date in [from,to] (installments scheduled in period)',
      basis_actual: 'lipa_transactions.ingested_at in [from,to]; amounts summed by claimed_loan_id',
      from,
      to,
      expected_total: Math.round(expectedTotal * 100) / 100,
      lipa_cash_total: Math.round(actualTotal * 100) / 100,
      portfolio_shortfall: Math.round((expectedTotal - actualTotal) * 100) / 100,
    };

    if (format === 'csv') {
      const lines = [
        toCsvRow(['loan_id', 'expected_due_in_period', 'lipa_claimed_in_period', 'shortfall']),
      ];
      for (const r of perLoan) {
        lines.push(toCsvRow([r.loan_id, r.expected_due_in_period, r.lipa_claimed_in_period, r.shortfall]));
      }
      lines.push(toCsvRow(['TOTAL', summary.expected_total, summary.lipa_cash_total, summary.portfolio_shortfall]));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="expected-vs-actual.csv"');
      return res.send(lines.join('\n'));
    }

    return res.json({
      success: true,
      summary,
      per_loan: perLoan,
      definition: { complete_loans_only: !incAll, include_incomplete: incAll },
    });
  } catch (err) {
    console.error('[accounting:expected-vs-actual]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/disbursements?from=&to=&format= ─────────────
router.get('/reports/disbursements', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from).toISOString() : null;
    const to = req.query.to ? new Date(req.query.to).toISOString() : null;
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'from and to (ISO dates) are required' });
    }
    const format = String(req.query.format || 'json').toLowerCase();

    const { data: rows, error } = await supabase
      .from('loans')
      .select('loan_id, borrower_id, principal_amount, outstanding_amount, disbursed_at, device_status')
      .not('disbursed_at', 'is', null)
      .gte('disbursed_at', from)
      .lte('disbursed_at', to)
      .order('disbursed_at', { ascending: false })
      .limit(10000);
    if (error) throw error;

    const list = rows || [];
    let principalSum = 0;
    for (const r of list) principalSum += Number(r.principal_amount) || 0;

    if (format === 'csv') {
      const header = toCsvRow(['disbursed_at', 'loan_id', 'borrower_id', 'principal_amount', 'outstanding_amount', 'device_status']);
      const lines = [header];
      for (const r of list) {
        lines.push(
          toCsvRow([
            r.disbursed_at,
            r.loan_id,
            r.borrower_id,
            r.principal_amount,
            r.outstanding_amount,
            r.device_status,
          ]),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="disbursements.csv"');
      return res.send(lines.join('\n'));
    }

    return res.json({
      success: true,
      from,
      to,
      count: list.length,
      principal_total: Math.round(principalSum * 100) / 100,
      loans: list,
    });
  } catch (err) {
    console.error('[accounting:disbursements]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/customers-workflow (customers only; all-time) ─
router.get('/reports/customers-workflow', async (req, res) => {
  try {
    const nowMs = Date.now();
    if (
      customersWorkflowCache.payload &&
      nowMs - customersWorkflowCache.at_ms < CUSTOMERS_WORKFLOW_CACHE_MS
    ) {
      return res.json(customersWorkflowCache.payload);
    }

    const completedQueueRows = await fetchAllCompletedDisbursementQueueRows(
      supabase,
      'loan_id, borrower_id',
    );
    const customerLoanIds = [
      ...new Set((completedQueueRows || []).map((r) => r.loan_id).filter(Boolean)),
    ];
    if (!customerLoanIds.length) {
      const payload = {
        success: true,
        generated_at: new Date().toISOString(),
        customers_only_definition: customersOnlyDefinition(),
        customers_count: 0,
        completed_disbursement_loan_count: 0,
        first_time_disbursement_loan_count: 0,
        repeat_disbursement_loan_count: 0,
        paid_customers_count: 0,
        overdue_customers_count: 0,
        overdue_amount_total: 0,
        amount_received_total: 0,
        amount_disbursed_total: 0,
        profit: 0,
        status_color: 'green',
        workflow_counts: { active: 0, paid: 0, overdue: 0 },
        note:
          'No customer loans found (requires cash_disbursement_queue.status=completed).',
      };
      customersWorkflowCache = { at_ms: nowMs, payload };
      return res.json(payload);
    }

    const loanList = await fetchLoansInIdChunks(
      supabase,
      customerLoanIds,
      'loan_id, borrower_id, principal_amount, outstanding_amount, repaid_at',
    );
    const loansByLoanIdForCustomers = new Map();
    for (const loan of loanList) {
      if (loan.loan_id) loansByLoanIdForCustomers.set(loan.loan_id, loan);
    }
    const disbursementBreakdown = summarizeCompletedDisbursementBreakdown(
      completedQueueRows,
      loansByLoanIdForCustomers,
    );
    const customers_count = disbursementBreakdown.distinct_borrowers;
    const completed_disbursement_loan_count = disbursementBreakdown.total_loans;
    const first_time_disbursement_loan_count = disbursementBreakdown.first_time_loans;
    const repeat_disbursement_loan_count = disbursementBreakdown.repeat_loans;

    // Paid = any loan repaid (on customer-only subset).
    const paidBorrowers = new Set(
      loanList
        .filter((l) => l.repaid_at || (Number(l.outstanding_amount) || 0) <= 0)
        .map((l) => l.borrower_id)
        .filter(Boolean),
    );

    const borrowerIdByLoanId = new Map(
      loanList
        .filter((l) => l.loan_id && l.borrower_id)
        .map((l) => [l.loan_id, l.borrower_id]),
    );
    const asOfMs = Date.now();
    const invRowsRaw = await selectRowsInIdChunks(
      supabase,
      'loan_invoices',
      'loan_id',
      customerLoanIds,
      'loan_id, borrower_id, due_date, status, amount_due',
      { in: { status: ['pending', 'overdue'] } },
    );
    const overdueSummary = summarizePastDueInvoices(invRowsRaw, asOfMs, borrowerIdByLoanId);

    let amount_disbursed_total = 0;
    for (const l of loanList) amount_disbursed_total += Number(l.principal_amount) || 0;

    // Received = sum lipa_transactions.amount for claimed customer loans.
    const { data: lipaRows, error: pErr } = await supabase
      .from('lipa_transactions')
      .select('amount, claimed_loan_id')
      .not('claimed_loan_id', 'is', null)
      .limit(200000);
    if (pErr) throw pErr;

    const customerLoanIdSet = new Set(customerLoanIds);
    let amount_received_total = 0;
    for (const row of lipaRows || []) {
      const lid = row.claimed_loan_id;
      if (lid && customerLoanIdSet.has(lid)) amount_received_total += Number(row.amount) || 0;
    }

    const profit = computeProfit(amount_received_total, amount_disbursed_total);
    const status_color = profitStatusColor(profit);

    // Workflow counts (customers-only loans)
    const activeLoanIds = new Set(
      loanList
        .filter((l) => !l.repaid_at && (Number(l.outstanding_amount) || 0) > 0)
        .map((l) => l.loan_id)
        .filter(Boolean),
    );
    const paidLoanIds = new Set(
      loanList
        .filter((l) => l.repaid_at || (Number(l.outstanding_amount) || 0) <= 0)
        .map((l) => l.loan_id)
        .filter(Boolean),
    );
    const payload = {
      success: true,
      generated_at: new Date().toISOString(),
      customers_only_definition: customersOnlyDefinition(),
      customers_count,
      completed_disbursement_loan_count,
      first_time_disbursement_loan_count,
      repeat_disbursement_loan_count,
      paid_customers_count: paidBorrowers.size,
      overdue_customers_count: overdueSummary.overdue_customers_count,
      overdue_amount_total: overdueSummary.overdue_amount_total,
      amount_received_total: Math.round(amount_received_total * 100) / 100,
      amount_disbursed_total: Math.round(amount_disbursed_total * 100) / 100,
      profit,
      status_color,
      workflow_counts: {
        active: activeLoanIds.size,
        paid: paidLoanIds.size,
        overdue: overdueSummary.overdue_loan_count,
      },
      note:
        'All-time; amounts received are from lipa_transactions where claimed_loan_id belongs to customers-only loans.',
    };

    customersWorkflowCache = { at_ms: nowMs, payload };
    return res.json(payload);
  } catch (err) {
    console.error('[accounting:customers-workflow]', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/overdue-customers ────────────────────────────
router.get('/reports/overdue-customers', async (req, res) => {
  try {
    const scopeRaw = req.query.scope != null ? String(req.query.scope).trim().toLowerCase() : '';
    const scope = scopeRaw === 'all' ? 'all' : 'customers';
    const asOfMs = Date.now();
    const asOfIso = new Date(asOfMs).toISOString();

    let allowedLoanIds = null;
    if (scope === 'customers') {
      const ids = await computeCustomersOnlyLoanIds();
      allowedLoanIds = new Set(ids);
      if (!ids.length) {
        return res.json({
          success: true,
          generated_at: asOfIso,
          scope,
          definition: {
            overdue_invoice:
              'status overdue, or status pending with due_date before generated_at',
            scope_customers: 'loan_id in cash_disbursement_queue with status completed',
            scope_all: 'any loan',
            sort: 'max_days_past_due descending',
          },
          borrowers: [],
          note: 'No customer loans on file (no completed cash disbursement queue rows).',
        });
      }
    }

    let invRaw = [];
    if (scope === 'customers') {
      invRaw = await selectRowsInIdChunks(
        supabase,
        'loan_invoices',
        'loan_id',
        [...allowedLoanIds],
        'loan_id, borrower_id, invoice_number, installment_index, amount_due, due_date, status',
        { in: { status: ['pending', 'overdue'] } },
      );
    } else {
      const { data, error: iErr } = await supabase
        .from('loan_invoices')
        .select('loan_id, borrower_id, invoice_number, installment_index, amount_due, due_date, status')
        .in('status', ['pending', 'overdue'])
        .limit(100000);
      if (iErr) throw iErr;
      invRaw = data || [];
    }

    const filtered = (invRaw || []).filter((inv) => invoiceIsUnpaidPastDue(inv, asOfMs));

    const agg = new Map();
    for (const inv of filtered) {
      const bid = inv.borrower_id;
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
    const regByBorrower = new Map();
    const chunk = 150;
    for (let i = 0; i < borrowerIds.length; i += chunk) {
      const slice = borrowerIds.slice(i, i + chunk);
      const { data: regs, error: rErr } = await supabase
        .from('registrations')
        .select('borrower_id, full_name, phone')
        .in('borrower_id', slice);
      if (rErr) throw rErr;
      for (const r of regs || []) regByBorrower.set(r.borrower_id, r);
    }

    const borrowers = [...agg.values()]
      .map((a) => {
        const reg = regByBorrower.get(a.borrower_id);
        return {
          borrower_id: a.borrower_id,
          full_name: reg?.full_name != null ? String(reg.full_name).trim() || null : null,
          phone: reg?.phone != null ? String(reg.phone).trim() || null : null,
          overdue_installment_count: a.overdue_installment_count,
          total_amount_due: Math.round(a.total_amount_due * 100) / 100,
          oldest_due_date: a.oldest_due_date,
          max_days_past_due: a.max_days_past_due,
          loan_ids: [...a.loan_ids].sort(),
        };
      })
      .sort((x, y) => y.max_days_past_due - x.max_days_past_due);

    return res.json({
      success: true,
      generated_at: asOfIso,
      scope,
      definition: {
        overdue_invoice:
          'status overdue, or status pending with due_date before generated_at',
        scope_customers: 'loan_id in cash_disbursement_queue with status completed',
        scope_all: 'any loan',
        sort: 'max_days_past_due descending',
      },
      borrowers,
      overdue_installment_rows_considered: filtered.length,
    });
  } catch (err) {
    console.error('[accounting:overdue-customers]', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/maturity?withinDays=30 ──────────────────────
router.get('/reports/maturity', async (req, res) => {
  try {
    const incAll = includeIncompleteLoans(req);
    const withinDays = Math.min(365, Math.max(1, parseInt(req.query.withinDays, 10) || 30));
    const format = String(req.query.format || 'json').toLowerCase();
    const now = new Date();
    const end = new Date(now.getTime() + withinDays * 86400000);

    const { data: invs, error } = await supabase
      .from('loan_invoices')
      .select('loan_id, borrower_id, installment_index, amount_due, due_date, status, invoice_number')
      .in('status', ['pending', 'overdue'])
      .gte('due_date', now.toISOString())
      .lte('due_date', end.toISOString())
      .order('due_date', { ascending: true })
      .limit(10000);
    if (error) throw error;

    let list = invs || [];
    if (!incAll) {
      const confirmedSet = await fetchConfirmedLoanIdsSet();
      list = list.filter((inv) => confirmedSet.has(inv.loan_id));
    }
    if (format === 'csv') {
      const header = toCsvRow(['due_date', 'loan_id', 'borrower_id', 'installment_index', 'amount_due', 'status', 'invoice_number']);
      const lines = [header];
      for (const r of list) {
        lines.push(
          toCsvRow([
            r.due_date,
            r.loan_id,
            r.borrower_id,
            r.installment_index,
            r.amount_due,
            r.status,
            r.invoice_number,
          ]),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="maturity-upcoming-installments.csv"');
      return res.send(lines.join('\n'));
    }

    let amountSum = 0;
    for (const r of list) amountSum += Number(r.amount_due) || 0;

    return res.json({
      success: true,
      definition: { complete_loans_only: !incAll, include_incomplete: incAll },
      within_days: withinDays,
      window_end: end.toISOString(),
      installment_count: list.length,
      amount_due_total: Math.round(amountSum * 100) / 100,
      installments: list,
    });
  } catch (err) {
    console.error('[accounting:maturity]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/queues/unmatched-lipa ────────────────────────────────
router.get('/queues/unmatched-lipa', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data: rows, error, count } = await supabase
      .from('lipa_transactions')
      .select('*', { count: 'exact' })
      .is('claimed_borrower_id', null)
      .order('ingested_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      transactions: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:unmatched-lipa]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/queues/pending-refs ──────────────────────────────────
router.get('/queues/pending-refs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data: rows, error, count } = await supabase
      .from('payment_references')
      .select('*', { count: 'exact' })
      .eq('status', 'pending')
      .order('submitted_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      references: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:pending-refs]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/audit-log ────────────────────────────────────────────
router.get('/audit-log', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data: rows, error, count } = await supabase
      .from('accounting_audit_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      entries: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:audit-log]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

module.exports = router;
