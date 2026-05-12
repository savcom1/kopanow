'use strict';
const router = require('express').Router();
const supabase = require('../helpers/supabase');
const {
  assertIdentifiersFreeForEnrollment,
  assertPhoneEligibleForNewLoan,
  normalizePhone,
  tzPhoneLookupCandidates,
  normalizeImei,
} = require('../helpers/deviceEnrollment');
const {
  parseRepaymentMonths,
  computeRepaymentSchedule,
  createInvoicesForLoan,
} = require('../helpers/loanInvoices');
const { canonicalizeDeviceModel } = require('../helpers/deviceModel');
const { resolveMkopoForDevice, resolveMkopoForDeviceStrict } = require('../helpers/mkopoResolve');
const { enforceUnsupportedMkopoDefault } = require('../helpers/mkopoUnsupportedPolicy');
const {
  applyRenewalPrincipalPolicy,
  mkopoArgsFromDeviceRow,
} = require('../helpers/renewalPrincipal');
const { enforceMinSupportedAppVersion, extractAppVersionCode } = require('../helpers/versionGate');

async function reportUnsupportedMkopoIfNeeded(payload) {
  try {
    const {
      borrower_id,
      full_name,
      phone,
      national_id,
      region,
      address,
      manufacturer,
      brand,
      device_model,
      build_device,
      build_product,
      android_version,
      sdk_version,
      device_id,
      imei,
      app_version_code,
      app_version_name,
    } = payload || {};

    // Require a minimal device signature to avoid spammy inserts.
    const man = String(manufacturer || '').trim();
    const br  = String(brand || '').trim();
    const mod = String(device_model || '').trim();
    if (!man || !br || !mod) return;

    // Dedupe: same device_id + model + app_version_code within 24h → skip.
    const did = device_id != null ? String(device_id).trim() : '';
    const appCode = app_version_code != null ? Number(app_version_code) : null;
    if (did && Number.isFinite(appCode)) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: rows, error } = await supabase
        .from('mkopo_unsupported_device_reports')
        .select('id')
        .eq('device_id', did)
        .eq('device_model', mod)
        .eq('app_version_code', appCode)
        .gte('created_at', since)
        .limit(1);
      if (error) throw error;
      if (rows && rows.length) return;
    }

    await supabase
      .from('mkopo_unsupported_device_reports')
      .insert({
        borrower_id: borrower_id != null ? String(borrower_id).trim() || null : null,
        full_name: full_name != null ? String(full_name).trim() || null : null,
        phone: phone != null ? String(phone).trim() || null : null,
        national_id: national_id != null ? String(national_id).trim() || null : null,
        region: region != null ? String(region).trim() || null : null,
        address: address != null ? String(address).trim() || null : null,
        manufacturer: man,
        brand: br,
        device_model: mod,
        build_device: build_device != null ? String(build_device).trim() || null : null,
        build_product: build_product != null ? String(build_product).trim() || null : null,
        android_version: android_version != null ? String(android_version).trim() || null : null,
        sdk_version:
          typeof sdk_version === 'number'
            ? sdk_version
            : Number.isFinite(parseInt(sdk_version, 10))
              ? parseInt(sdk_version, 10)
              : null,
        device_id: did || null,
        imei:
          imei != null
            ? String(imei)
                .replace(/\D/g, '')
                .slice(0, 32) || null
            : null,
        app_version_code: Number.isFinite(appCode) ? appCode : null,
        app_version_name: app_version_name != null ? String(app_version_name).trim().slice(0, 64) || null : null,
        client_timestamp_ms: Date.now(),
      })
      .throwOnError();
  } catch (e) {
    // Never fail the loan request because of reporting.
    console.warn('[loan:request] mkopo_unsupported report failed:', e.message || String(e));
  }
}

function generateLoanId() {
  // Human-readable-ish unique loan id
  return `LN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * POST /api/accounting/loan/renew (canonical) — same handler as POST /api/loan/renew (legacy alias).
 *
 * Creates a brand-new loan + invoice schedule **only** when the previous loan is completed.
 * The Android app uses this to renew after a paid/completed loan without re-entering details.
 *
 * Body:
 * - borrower_id (required)
 * - previous_loan_id (required)
 * - repayment_months (optional 1..3; defaults to previous loan's term if available, else 1)
 * - app_version_code / app_version_name (recommended) — same min-version gate as POST /request
 */
router.post('/renew', async (req, res) => {
  try {
    const versionBlocked = enforceMinSupportedAppVersion(req, res);
    if (versionBlocked) return;

    const b = req.body || {};
    const borrower_id = b.borrower_id != null ? String(b.borrower_id).trim() : '';
    const previous_loan_id = b.previous_loan_id != null ? String(b.previous_loan_id).trim() : '';
    const repayment_months_raw = b.repayment_months;

    if (!borrower_id || !previous_loan_id) {
      return res.status(400).json({
        success: false,
        message: 'borrower_id and previous_loan_id are required.',
      });
    }

    const [{ data: reg, error: regErr }, { data: prevLoan, error: prevErr }] = await Promise.all([
      supabase
        .from('registrations')
        .select('phone, full_name, region')
        .eq('borrower_id', borrower_id)
        .maybeSingle(),
      supabase.from('loans').select('*').eq('loan_id', previous_loan_id).maybeSingle(),
    ]);
    if (regErr) throw regErr;
    if (prevErr) throw prevErr;
    if (!reg) return res.status(404).json({ success: false, message: 'Borrower not found.' });
    if (!prevLoan) return res.status(404).json({ success: false, message: 'Previous loan not found.' });
    if (String(prevLoan.borrower_id || '').trim() !== borrower_id) {
      return res.status(403).json({
        success: false,
        message: 'Previous loan does not belong to this borrower.',
      });
    }

    // Completion gate: repaid_at set + outstanding_amount <= 0 + no unpaid invoices.
    const prevOutstanding = Number(prevLoan.outstanding_amount || 0);
    if (!prevLoan.repaid_at || prevOutstanding > 0) {
      return res.status(409).json({
        success: false,
        message: 'Renewal not allowed: your previous loan is not completed yet.',
      });
    }
    const { data: prevUnpaid, error: invErr } = await supabase
      .from('loan_invoices')
      .select('id, status')
      .eq('loan_id', previous_loan_id)
      .in('status', ['pending', 'overdue'])
      .limit(5);
    if (invErr) throw invErr;
    if ((prevUnpaid || []).length) {
      return res.status(409).json({
        success: false,
        message: 'Renewal not allowed: some installments are still unpaid.',
      });
    }

    // Phone gate: active / duplicate-line policies (canonical MSISDN).
    const phoneNorm = normalizePhone(reg.phone);
    const elig = await assertPhoneEligibleForNewLoan(phoneNorm);
    if (!elig.ok) {
      return res.status(409).json({ success: false, message: elig.reason });
    }

    const prevPrincipal = Number(prevLoan.principal_amount || 0);
    if (!Number.isFinite(prevPrincipal) || prevPrincipal <= 0) {
      return res.status(409).json({
        success: false,
        message: 'Renewal not allowed: previous loan principal is missing/invalid.',
      });
    }

    const { data: prevDevice } = await supabase
      .from('devices')
      .select('device_id, device_model, mpesa_phone, device_info, imei')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', previous_loan_id)
      .maybeSingle();

    const mkopoRenew = resolveMkopoForDevice(mkopoArgsFromDeviceRow(prevDevice));
    if (!mkopoRenew && prevDevice) {
      console.warn(
        `[loan:renew] MKOPO catalog miss for borrower=${borrower_id} previous_loan=${previous_loan_id}; renewal principal not handset-capped.`
      );
    }
    const renewalApplied = applyRenewalPrincipalPolicy(prevPrincipal, mkopoRenew);
    const principal = renewalApplied.principal;
    const principal_multiplier = renewalApplied.principal_multiplier;
    if (mkopoRenew && renewalApplied.principal !== renewalApplied.computedBeforeClamp) {
      console.warn(
        `[loan:renew] renewal MKOPO clamp borrower=${borrower_id} computed=${renewalApplied.computedBeforeClamp} principal=${principal} label=${mkopoRenew.label}`
      );
    }

    const monthsDefault =
      prevLoan.installment_weeks != null && Number(prevLoan.installment_weeks) > 0
        ? Math.max(1, Math.min(3, Math.round(Number(prevLoan.installment_weeks) / 4)))
        : 1;
    const months = parseRepaymentMonths({
      repayment_months: repayment_months_raw ?? monthsDefault,
      installment_weeks: null,
      tenor_days: null,
    });

    const loan_id = generateLoanId();
    const schedule = computeRepaymentSchedule(principal, months);
    const now = new Date().toISOString();

    const imeiRenew =
      normalizeImei(b.imei) || normalizeImei(prevDevice?.imei) || null;

    await supabase
      .from('loans')
      .insert({
        loan_id,
        borrower_id,
        principal_amount: principal,
        outstanding_amount: schedule.totalRepayment,
        interest_amount: schedule.interest_amount,
        device_status: 'unregistered',
        created_at: now,
        updated_at: now,
      })
      .throwOnError();

    await createInvoicesForLoan({
      loan_id,
      borrower_id,
      borrower_name: reg.full_name || null,
      principal_amount: principal,
      repayment_months: months,
      schedule_start: now,
    });

    const device_info =
      prevDevice?.device_info && typeof prevDevice.device_info === 'object'
        ? { ...prevDevice.device_info, source: 'renewal' }
        : { source: 'renewal' };
    const { error: devUpsertErr } = await supabase
      .from('devices')
      .upsert(
        {
          borrower_id,
          loan_id,
          device_id: prevDevice?.device_id || null,
          imei: imeiRenew,
          device_model: prevDevice?.device_model || null,
          mpesa_phone: normalizePhone(prevDevice?.mpesa_phone || reg.phone || '') || null,
          status: 'registered',
          dpc_active: false,
          device_info,
          updated_at: now,
        },
        { onConflict: 'borrower_id,loan_id' },
      );
    if (devUpsertErr) throw devUpsertErr;

    const contractNumber = `KN-${String(loan_id).replace(/[^A-Za-z0-9]/g, '').slice(-10)}-${Date.now().toString(36).toUpperCase()}`;

    return res.json({
      success: true,
      message: 'Renewal created. Please accept the new contract to continue.',
      borrower_id,
      previous_loan_id,
      previous_loan_status: prevLoan?.device_status || (prevLoan?.repaid_at ? 'paid' : 'active'),
      loan_id,
      new_loan_id: loan_id,
      renewal: true,
      principal_multiplier,
      principal_amount_tzs: principal,
      contract_number: contractNumber,
      total_repayment_tzs: Math.round(schedule.totalRepayment),
      weekly_installment_tzs: Math.round(schedule.weekly),
      num_weeks: schedule.weeks,
      loan_start_date: new Date(now).toISOString(),
    });
  } catch (err) {
    console.error('[loan:renew]', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Internal server error' });
  }
});

/**
 * GET /api/accounting/loan/history (canonical) — same handler as GET /api/loan/history (legacy alias).
 *
 * Returns all loans for the borrower, newest first, with a convenience `is_current` marker.
 *
 * Query:
 * - borrower_id (required)
 * - current_loan_id (optional) — if provided, marks the matching loan as current
 */
router.get('/history', async (req, res) => {
  try {
    const borrower_id = req.query.borrower_id != null ? String(req.query.borrower_id).trim() : '';
    const current_loan_id = req.query.current_loan_id != null ? String(req.query.current_loan_id).trim() : '';
    if (!borrower_id) {
      return res.status(400).json({ success: false, message: 'borrower_id is required.' });
    }

    const { data: rows, error } = await supabase
      .from('loans')
      .select('loan_id, device_status, created_at, repaid_at, principal_amount, outstanding_amount, next_due_date')
      .eq('borrower_id', borrower_id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const list = (rows || []).map((r) => ({
      loan_id: r.loan_id,
      status: r.device_status || (r.repaid_at ? 'paid' : 'active'),
      created_at: r.created_at,
      repaid_at: r.repaid_at,
      principal_amount: r.principal_amount,
      outstanding_amount: r.outstanding_amount,
      next_due_date: r.next_due_date,
      is_current: current_loan_id ? String(r.loan_id || '').trim() === current_loan_id : false,
    }));

    return res.json({ success: true, borrower_id, current_loan_id: current_loan_id || null, loans: list });
  } catch (err) {
    console.error('[loan:history]', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Internal server error' });
  }
});

// POST /api/loan/request
// Called by Android RegistrationActivity before activation is allowed.
router.post('/request', async (req, res) => {
  try {
    const versionBlocked = enforceMinSupportedAppVersion(req, res);
    if (versionBlocked) return;

    const {
      borrower_id,
      phone,
      full_name,
      national_id,
      region,
      address,
      amount_tzs,
      /** 1–3: total = principal×(120%/140%/160%); weekly = total÷(4×months). */
      repayment_months,
      /** Legacy: 4, 8, or 12 weeks if months not sent. */
      installment_weeks,
      tenor_days,
      purpose,
      device_id,
      device_model,
      manufacturer,
      brand,
      android_version,
      sdk_version,
      screen_density,
      screen_width_dp,
      screen_height_dp,
      battery_pct,
      build_product,
      build_device,
      is_rooted,
      imei,
      imeis,
      // Optional (may also be provided via headers; see extractAppVersionCode).
      app_version_name,
    } = req.body || {};

    const appVersionCode = extractAppVersionCode(req);
    const appVersionName =
      app_version_name != null ? String(app_version_name).trim().slice(0, 64) || null : null;

    if (!borrower_id || !phone || !full_name || !national_id || !region || !address || !amount_tzs || !purpose) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const phoneNorm = normalizePhone(phone);
    if (!phoneNorm) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Tanzania phone number. Use 07XXXXXXXX or 255XXXXXXXXX.',
      });
    }

    const canonicalModel =
      canonicalizeDeviceModel({ manufacturer, brand, model: device_model }) || null;

    const rmQuick = repayment_months != null ? parseInt(repayment_months, 10) : NaN;
    const hasTerm =
      (tenor_days != null && Number(tenor_days) > 0) ||
      (Number.isFinite(rmQuick) && rmQuick >= 1 && rmQuick <= 3);
    if (!hasTerm) {
      return res.status(400).json({ success: false, message: 'Provide tenor_days or repayment_months (1–3).' });
    }

    const elig = await assertPhoneEligibleForNewLoan(phoneNorm);
    if (!elig.ok) {
      return res.status(409).json({ success: false, message: elig.reason });
    }

    // Resume unfinished: if this phone already has an unconfirmed active loan, return it (no new loan created).
    const phoneCandidates = tzPhoneLookupCandidates(phoneNorm);
    const { data: regRows, error: regFindErr } = await supabase
      .from('registrations')
      .select('borrower_id')
      .in('phone', phoneCandidates)
      .limit(20);
    if (regFindErr) throw regFindErr;
    const distinctBorrowers = [...new Set((regRows || []).map((r) => r.borrower_id).filter(Boolean))];
    if (distinctBorrowers.length > 1) {
      console.warn(`[loan:request] BLOCK phone=${phoneNorm}: conflicting borrower rows`);
      return res.status(409).json({
        success: false,
        message: 'This phone number is linked to multiple accounts. Please contact support.',
      });
    }
    const existingBorrowerId = distinctBorrowers[0] || null;

    if (existingBorrowerId) {
      const { data: existingLoan, error: loanFindErr } = await supabase
        .from('loans')
        .select('loan_id, borrower_id, cash_disbursement_confirmed_at, repaid_at, outstanding_amount, created_at')
        .eq('borrower_id', existingBorrowerId)
        .is('cash_disbursement_confirmed_at', null)
        .is('repaid_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (loanFindErr) throw loanFindErr;
      if (existingLoan?.loan_id) {
        return res.json({
          success: true,
          message: 'Resuming your existing loan request.',
          borrower_id: existingBorrowerId,
          loan_id: existingLoan.loan_id,
          resume: true,
        });
      }
    }

    // Renewal policy: if this phone already has a registration, reuse that borrower_id
    // so repeat loans stay attached to the same customer identity.
    const effectiveBorrowerId = existingBorrowerId || borrower_id;

    const loan_id = generateLoanId();

    let principal = Number(amount_tzs);
    let isRenewal = false;

    // For loan requests we use STRICT model/pattern matching only.
    // Brand-default fallback tiers can cause unsupported handsets to be rejected as “out of range”.
    const mkopoSuggestion = resolveMkopoForDeviceStrict({
      manufacturer,
      brand,
      model: device_model,
      device: build_device,
    });

    // Renewal: same borrower + completed loan → principal = 15% uplift, clamped to handset MKOPO [min,max] when catalog resolves.
    if (existingBorrowerId) {
      const { data: lastCompleted, error: compErr } = await supabase
        .from('loans')
        .select('loan_id, principal_amount, repaid_at')
        .eq('borrower_id', existingBorrowerId)
        .not('repaid_at', 'is', null)
        .order('repaid_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (compErr) throw compErr;
      if (lastCompleted?.principal_amount != null) {
        const prev = Number(lastCompleted.principal_amount);
        if (Number.isFinite(prev) && prev > 0) {
          const applied = applyRenewalPrincipalPolicy(prev, mkopoSuggestion);
          if (applied) {
            principal = applied.principal;
            isRenewal = true;
            if (mkopoSuggestion && applied.principal !== applied.computedBeforeClamp) {
              console.warn(
                `[loan:request] renewal MKOPO clamp borrower=${effectiveBorrowerId} computed=${applied.computedBeforeClamp} principal=${principal} label=${mkopoSuggestion.label}`
              );
            }
          }
        }
      }
    }
    const months = parseRepaymentMonths({
      repayment_months,
      installment_weeks,
      tenor_days,
    });

    // Unsupported handset (catalog miss) policy:
    // - New requests: force minimal default principal (10,000 TZS).
    // - Renewals: policy is handled above (15% uplift + optional handset clamp when catalog resolves).
    if (mkopoSuggestion == null && !isRenewal) {
      reportUnsupportedMkopoIfNeeded({
        borrower_id: effectiveBorrowerId,
        full_name,
        phone: phoneNorm,
        national_id,
        region,
        address,
        manufacturer,
        brand,
        device_model,
        build_device,
        build_product,
        android_version,
        sdk_version,
        device_id,
        imei,
        app_version_code: appVersionCode,
        app_version_name: appVersionName,
      });
    }
    principal = enforceUnsupportedMkopoDefault(principal, mkopoSuggestion, isRenewal);

    // Catalog hit on new (non-renewal) requests: enforce principal within [min,max].
    if (mkopoSuggestion != null && !isRenewal) {
      const min = mkopoSuggestion.amountTzsRounded;
      const max = mkopoSuggestion.amountMaxTzsRounded ?? min;
      const principalRounded = Math.round(Number(principal));
      if (!Number.isFinite(principalRounded) || principalRounded < min || principalRounded > max) {
        console.warn(
          `[loan:request] MKOPO range mismatch borrower=${effectiveBorrowerId} principal=${principalRounded} min=${min} max=${max} label=${mkopoSuggestion.label}`
        );
        return res.status(400).json({
          success: false,
          message:
            'Loan amount is outside the allowed range for this device. Use the minimum and maximum amounts shown in the app.',
        });
      }
    }

    const schedule = computeRepaymentSchedule(principal, months);
    const totalRepayment = schedule.totalRepayment;
    const interestAmount = schedule.interest_amount;
    const tenorDaysStored = Math.round(30 * months);

    const didTrim = device_id != null ? String(device_id).trim() : '';
    const imeiNormLoan = normalizeImei(imei);
    if (didTrim || imeiNormLoan || (Array.isArray(imeis) && imeis.length)) {
      const enr = await assertIdentifiersFreeForEnrollment(
        device_id,
        imei,
        effectiveBorrowerId,
        loan_id,
        null,
        imeis,
      );
      if (!enr.ok) {
        return res.status(409).json({ success: false, message: enr.reason });
      }
    }

    // 1) Upsert registration/profile
    const now = new Date().toISOString();
    const { error: regErr } = await supabase
      .from('registrations')
      .upsert({
        borrower_id: effectiveBorrowerId,
        phone: phoneNorm,
        full_name,
        national_id,
        region,
        address,
        updated_at: now
      }, { onConflict: 'borrower_id' });
    if (regErr) throw regErr;

    // 2) Insert loan request (immutable record)
    const { error: reqErr } = await supabase
      .from('loan_requests')
      .insert({
        borrower_id: effectiveBorrowerId,
        loan_id,
        amount_tzs: principal,
        tenor_days: tenorDaysStored,
        purpose,
        status: 'submitted'
      });
    if (reqErr) throw reqErr;

    // 3) Create a loan row so the rest of the system can reference it
    // (Admin can later approve/update amounts / due dates.)
    await supabase
      .from('loans')
      .insert({
        loan_id,
        borrower_id: effectiveBorrowerId,
        principal_amount: principal,
        outstanding_amount: totalRepayment,
        interest_amount: interestAmount,
        device_status: 'unregistered',
        created_at: now,
        updated_at: now,
      })
      .throwOnError();

    // 3b) Weekly installments: total = principal × 120%/140%/160%, ÷ (4×months) weeks
    await createInvoicesForLoan({
      loan_id,
      borrower_id: effectiveBorrowerId,
      borrower_name: full_name,
      principal_amount: principal,
      repayment_months: months,
      schedule_start: now,
    });

    // 4) Pre-create / update devices row so admin UI lists the handset with device_id
    //    before MDM enrollment (dpc_active = false until /api/device/register).
    const device_info = {
      source: 'loan_registration',
      registered_at: now,
      manufacturer: manufacturer || null,
      brand: brand || null,
      android_version: android_version || null,
      sdk_version: sdk_version ?? null,
      screen_density: screen_density ?? null,
      screen_width_dp: screen_width_dp ?? null,
      screen_height_dp: screen_height_dp ?? null,
      battery_pct: battery_pct ?? null,
      build_product: build_product || null,
      build_device: build_device || null,
      device_model_raw: device_model || null,
      device_model_canonical: canonicalModel,
      is_rooted: is_rooted ?? null
    };
    const { error: devUpsertErr } = await supabase
      .from('devices')
      .upsert({
        borrower_id: effectiveBorrowerId,
        loan_id,
        device_id: device_id || null,
        imei: imeiNormLoan || null,
        device_model: canonicalModel || device_model || null,
        mpesa_phone: phoneNorm,
        status: 'registered',
        dpc_active: false,
        device_info,
        updated_at: now
      }, { onConflict: 'borrower_id,loan_id' });
    if (devUpsertErr) throw devUpsertErr;

    const scheduleStart = new Date(now);
    const contractNumber = `KN-${String(loan_id).replace(/[^A-Za-z0-9]/g, '').slice(-10)}-${Date.now().toString(36).toUpperCase()}`;

    return res.json({
      success: true,
      message: isRenewal ? 'Loan renewal request submitted.' : 'Loan request submitted.',
      borrower_id: effectiveBorrowerId,
      loan_id,
      renewal: isRenewal,
      principal_amount_tzs: principal,
      contract_number: contractNumber,
      total_repayment_tzs: Math.round(schedule.totalRepayment),
      weekly_installment_tzs: Math.round(schedule.weekly),
      num_weeks: schedule.weeks,
      loan_start_date: scheduleStart.toISOString(),
    });
  } catch (err) {
    const msg = err?.message || 'Internal server error';
    console.error('[loan:request]', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

/** Empty string → null so Postgres TIMESTAMPTZ / TEXT columns never get "". */
function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// POST /api/loan/contract-acceptance — minimal row (ids + time + device); contract text lives in the app only.
router.post('/contract-acceptance', async (req, res) => {
  try {
    const b = req.body || {};
    const contract_number = b.contract_number != null ? String(b.contract_number).trim() : '';
    const loan_id = b.loan_id != null ? String(b.loan_id).trim() : '';
    const borrower_id = b.borrower_id != null ? String(b.borrower_id).trim() : '';
    if (!contract_number || !loan_id || !borrower_id) {
      return res.status(400).json({ success: false, message: 'contract_number, loan_id, and borrower_id are required.' });
    }

    const row = {
      contract_number,
      loan_id,
      borrower_id,
      borrower_name: trimOrNull(b.borrower_name),
      borrower_phone: trimOrNull(b.borrower_phone),
      borrower_region: trimOrNull(b.borrower_region),
      first_repayment_date: trimOrNull(b.first_repayment_date),
      last_repayment_date: trimOrNull(b.last_repayment_date),
      accepted_at: new Date().toISOString(),
      android_device_id: trimOrNull(b.android_device_id) || 'unknown',
      app_version: trimOrNull(b.app_version) || 'unknown',
    };

    const { error } = await supabase.from('contract_acceptances').insert(row);
    if (error) {
      if (String(error.message || '').includes('duplicate') || String(error.code) === '23505') {
        return res.status(409).json({ success: false, message: 'Contract number already recorded.' });
      }
      throw error;
    }
    return res.json({ success: true, message: 'Contract acceptance saved.', contract_number });
  } catch (err) {
    console.error('[loan:contract-acceptance]', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
});

module.exports = router;

