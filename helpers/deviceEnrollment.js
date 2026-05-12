'use strict';

const supabase = require('./supabase');

/**
 * Tanzania MSISDN canonical form (digits only, 255 + 9 digits).
 * Matches Android RegistrationActivity.normalizeTzPhoneTo255.
 *
 * @returns {string} canonical digits or '' if invalid
 */
function canonicalizeTzPhoneDigits(raw) {
  if (raw == null || raw === '') return '';
  const onlyDigits = String(raw).replace(/\D/g, '');
  if (onlyDigits.length === 10 && onlyDigits.startsWith('0')) {
    return `255${onlyDigits.slice(1)}`;
  }
  if (onlyDigits.length === 12 && onlyDigits.startsWith('255')) {
    return onlyDigits;
  }
  return '';
}

/**
 * Trim whitespace then canonicalize TZ mobile (strict).
 * Use for writes and lookups after canonical migration; paired with {@link tzPhoneLookupCandidates}.
 */
function normalizePhone(phone) {
  if (phone == null || phone === '') return '';
  const trimmed = String(phone).trim().replace(/\s+/g, '');
  return canonicalizeTzPhoneDigits(trimmed);
}

/**
 * Values that might appear in `registrations.phone` for the same line (legacy `0712…` vs `255712…`).
 *
 * @param {string} canonical — output of {@link normalizePhone} / {@link canonicalizeTzPhoneDigits}
 * @returns {string[]}
 */
function tzPhoneLookupCandidates(canonical) {
  const c = canonicalizeTzPhoneDigits(canonical);
  if (!c) return [];
  const out = new Set([c]);
  if (c.length === 12 && c.startsWith('255')) {
    out.add(`0${c.slice(3)}`);
  }
  return [...out];
}

/**
 * Normalize IMEI: digits only; typical length 14–15 (accept 12–17 for MVNO quirks).
 */
function normalizeImei(raw) {
  if (raw == null) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 17) return '';
  return digits;
}

/** Deduped normalized IMEIs from an array and/or single primary field. */
function normalizeImeiList(imeis, imei) {
  const out = new Set();
  if (Array.isArray(imeis)) {
    for (const value of imeis) {
      const n = normalizeImei(value);
      if (n) out.add(n);
    }
  }
  const single = normalizeImei(imei);
  if (single) out.add(single);
  return [...out];
}

function mergeStoredImeis(incomingImeis, existingRow) {
  const fromRow = Array.isArray(existingRow?.imeis) ? existingRow.imeis : [];
  return normalizeImeiList([...incomingImeis, ...fromRow], existingRow?.imei);
}

/** Uppercase alphanumeric hardware serial from About / Build.getSerial. */
function normalizeHardwareSerial(raw) {
  if (raw == null) return '';
  const s = String(raw).trim().replace(/\s+/g, '').toUpperCase();
  if (!s) return '';
  if (s === 'UNKNOWN' || s === 'UNKNOWN_SERIAL') return '';
  if (s === '9774D56D682E549C') return '';
  if (s.length < 4 || s.length > 64) return '';
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(s)) return '';
  return s;
}

/**
 * One physical device (device_id) may only be linked to a single Kopanow enrollment
 * (borrower_id + loan_id). Re-syncing the same enrollment is allowed.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
async function assertDeviceFreeForEnrollment(device_id, borrower_id, loan_id) {
  const id = device_id != null ? String(device_id).trim() : '';
  if (!id) {
    return { ok: false, reason: 'Missing device identifier — cannot verify enrollment.' };
  }
  if (!borrower_id || !loan_id) {
    return { ok: false, reason: 'borrower_id and loan_id are required.' };
  }

  const { data: rows, error } = await supabase
    .from('devices')
    .select('borrower_id, loan_id')
    .eq('device_id', id);

  if (error) throw error;

  // Same enrollment re-sync is always allowed.
  const exact = (rows || []).find((r) => r.borrower_id === borrower_id && r.loan_id === loan_id);
  if (exact) return { ok: true };

  const otherBorrower = (rows || []).find((r) => r.borrower_id !== borrower_id);
  if (otherBorrower) {
    console.warn(
      `[enrollment] BLOCK device_id=${id} already linked to borrower=${otherBorrower.borrower_id} loan=${otherBorrower.loan_id}`
    );
    return {
      ok: false,
      reason: 'This device is already enrolled under another customer. Please use the original phone.',
    };
  }

  // Renewal policy: allow same device to be used again for the SAME borrower,
  // but only if the previous loan is completed (outstanding=0 and invoices paid).
  const priorLoans = (rows || []).map((r) => r.loan_id).filter(Boolean);
  if (priorLoans.length) {
    const { data: prior, error: pErr } = await supabase
      .from('loans')
      .select('loan_id, outstanding_amount, repaid_at')
      .in('loan_id', priorLoans)
      .limit(20);
    if (pErr) throw pErr;

    // If ANY prior loan for this borrower is still active, block.
    const active = (prior || []).find(
      (l) => l.repaid_at == null && Number(l.outstanding_amount || 0) > 0
    );
    if (active) {
      return {
        ok: false,
        reason: 'You still have an active loan on this device. Finish repayment before renewing.',
      };
    }
  }

  return { ok: true };
}

async function fetchDevicesByImei(im) {
  const { data: primaryRows, error: primaryErr } = await supabase
    .from('devices')
    .select('borrower_id, loan_id')
    .eq('imei', im);
  if (primaryErr) throw primaryErr;

  const { data: listRows, error: listErr } = await supabase
    .from('devices')
    .select('borrower_id, loan_id')
    .filter('imeis', 'cs', JSON.stringify([im]));
  if (listErr) throw listErr;

  const seen = new Map();
  for (const row of [...(primaryRows || []), ...(listRows || [])]) {
    if (!row) continue;
    seen.set(`${row.borrower_id}::${row.loan_id}`, row);
  }
  return [...seen.values()];
}

/**
 * Same policy as device_id but keyed by IMEI (nullable column).
 */
async function assertImeiFreeForEnrollment(imei, borrower_id, loan_id) {
  const im = normalizeImei(imei);
  if (!im) return { ok: true };
  if (!borrower_id || !loan_id) {
    return { ok: false, reason: 'borrower_id and loan_id are required.' };
  }

  const rows = await fetchDevicesByImei(im);

  const exact = (rows || []).find((r) => r.borrower_id === borrower_id && r.loan_id === loan_id);
  if (exact) return { ok: true };

  const otherBorrower = (rows || []).find((r) => r.borrower_id !== borrower_id);
  if (otherBorrower) {
    console.warn(
      `[enrollment] BLOCK imei=${im} already linked to borrower=${otherBorrower.borrower_id} loan=${otherBorrower.loan_id}`
    );
    return {
      ok: false,
      reason: 'This device is already enrolled under another customer. Please use the original phone.',
    };
  }

  const priorLoans = (rows || []).map((r) => r.loan_id).filter(Boolean);
  if (priorLoans.length) {
    const { data: prior, error: pErr } = await supabase
      .from('loans')
      .select('loan_id, outstanding_amount, repaid_at')
      .in('loan_id', priorLoans)
      .limit(20);
    if (pErr) throw pErr;

    const active = (prior || []).find(
      (l) => l.repaid_at == null && Number(l.outstanding_amount || 0) > 0
    );
    if (active) {
      return {
        ok: false,
        reason: 'You still have an active loan on this device. Finish repayment before renewing.',
      };
    }
  }

  return { ok: true };
}

async function assertImeisFreeForEnrollment(imeis, borrower_id, loan_id) {
  const list = normalizeImeiList(imeis, null);
  if (!list.length) return { ok: true };
  for (const im of list) {
    const result = await assertImeiFreeForEnrollment(im, borrower_id, loan_id);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Same policy as device_id / IMEI but keyed by hardware serial (About phone).
 */
async function assertSerialFreeForEnrollment(hardware_serial, borrower_id, loan_id) {
  const serial = normalizeHardwareSerial(hardware_serial);
  if (!serial) return { ok: true };
  if (!borrower_id || !loan_id) {
    return { ok: false, reason: 'borrower_id and loan_id are required.' };
  }

  const { data: rows, error } = await supabase
    .from('devices')
    .select('borrower_id, loan_id')
    .eq('hardware_serial', serial);

  if (error) throw error;

  const exact = (rows || []).find((r) => r.borrower_id === borrower_id && r.loan_id === loan_id);
  if (exact) return { ok: true };

  const otherBorrower = (rows || []).find((r) => r.borrower_id !== borrower_id);
  if (otherBorrower) {
    console.warn(
      `[enrollment] BLOCK hardware_serial=${serial} already linked to borrower=${otherBorrower.borrower_id} loan=${otherBorrower.loan_id}`,
    );
    return {
      ok: false,
      reason: 'This device is already enrolled under another customer. Please use the original phone.',
    };
  }

  const priorLoans = (rows || []).map((r) => r.loan_id).filter(Boolean);
  if (priorLoans.length) {
    const { data: prior, error: pErr } = await supabase
      .from('loans')
      .select('loan_id, outstanding_amount, repaid_at')
      .in('loan_id', priorLoans)
      .limit(20);
    if (pErr) throw pErr;

    const active = (prior || []).find(
      (l) => l.repaid_at == null && Number(l.outstanding_amount || 0) > 0,
    );
    if (active) {
      return {
        ok: false,
        reason: 'You still have an active loan on this device. Finish repayment before renewing.',
      };
    }
  }

  return { ok: true };
}

/**
 * Runs device_id gate when present, then IMEI gate when present, then hardware serial when present.
 */
async function assertIdentifiersFreeForEnrollment(
  device_id,
  imei,
  borrower_id,
  loan_id,
  hardware_serial,
  imeis,
) {
  const did = device_id != null ? String(device_id).trim() : '';
  if (did) {
    const r = await assertDeviceFreeForEnrollment(did, borrower_id, loan_id);
    if (!r.ok) return r;
  }
  const imList = normalizeImeiList(imeis, imei);
  if (imList.length) {
    const r = await assertImeisFreeForEnrollment(imList, borrower_id, loan_id);
    if (!r.ok) return r;
  }
  const serial = normalizeHardwareSerial(hardware_serial);
  if (serial) {
    const r = await assertSerialFreeForEnrollment(serial, borrower_id, loan_id);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/**
 * Policy gate for starting another loan on this MSISDN.
 *
 * - Blocks any **disbursed** active loan (cash_disbursement_confirmed_at set, outstanding > 0, not repaid).
 * - Blocks duplicate **borrower_id** rows for the same phone when any outstanding loan exists on pending disbursement.
 * - Allows a single borrower with only **pending disbursement** loans (resume flow in loan/request).
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
async function assertPhoneEligibleForNewLoan(phone) {
  const p = normalizePhone(phone);
  if (!p) return { ok: false, reason: 'Missing or invalid Tanzania phone number.' };

  const candidates = tzPhoneLookupCandidates(p);
  const { data: regs, error: rErr } = await supabase
    .from('registrations')
    .select('borrower_id, phone')
    .in('phone', candidates)
    .limit(50);
  if (rErr) throw rErr;

  const borrowerIds = [...new Set((regs || []).map((r) => r.borrower_id).filter(Boolean))];
  if (!borrowerIds.length) return { ok: true };

  const distinctRegBorrowers = borrowerIds.length;
  if (distinctRegBorrowers > 1) {
    console.warn(`[enrollment] BLOCK phone=${p}: multiple borrower rows for same line (${distinctRegBorrowers})`);
    return {
      ok: false,
      reason: 'This phone number is linked to multiple accounts. Please contact support.',
    };
  }

  const { data: loans, error: lErr } = await supabase
    .from('loans')
    .select('loan_id, borrower_id, outstanding_amount, repaid_at, cash_disbursement_confirmed_at')
    .in('borrower_id', borrowerIds)
    .is('repaid_at', null)
    .gt('outstanding_amount', 0)
    .limit(50);
  if (lErr) throw lErr;

  const active = loans || [];
  if (!active.length) return { ok: true };

  const confirmedActive = active.filter((l) => l.cash_disbursement_confirmed_at != null);
  if (confirmedActive.length) {
    return {
      ok: false,
      reason: 'You already have an active loan. Please finish repayment before requesting another loan.',
    };
  }

  // Only pending-disbursement / unconfirmed loans remain.
  const pendingBorrowers = [...new Set(active.map((l) => l.borrower_id).filter(Boolean))];
  if (pendingBorrowers.length !== 1 || pendingBorrowers[0] !== borrowerIds[0]) {
    return {
      ok: false,
      reason: 'You already have a loan request in progress. Open the app to continue or contact support.',
    };
  }
  if (active.length > 1) {
    return {
      ok: false,
      reason: 'Multiple open loan requests found for this phone. Please contact support.',
    };
  }

  return { ok: true };
}

module.exports = {
  assertDeviceFreeForEnrollment,
  assertImeiFreeForEnrollment,
  assertImeisFreeForEnrollment,
  assertSerialFreeForEnrollment,
  assertIdentifiersFreeForEnrollment,
  assertPhoneEligibleForNewLoan,
  normalizePhone,
  canonicalizeTzPhoneDigits,
  tzPhoneLookupCandidates,
  normalizeImei,
  normalizeImeiList,
  mergeStoredImeis,
  normalizeHardwareSerial,
};
