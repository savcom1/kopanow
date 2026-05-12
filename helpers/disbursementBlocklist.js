'use strict';

const supabase = require('./supabase');
const { normalizePhone, normalizeImei } = require('./deviceEnrollment');

/**
 * @param {string|null|undefined} rawPhone
 * @returns {Promise<boolean>}
 */
async function isPhoneBlockedForDisbursement(rawPhone) {
  const p = normalizePhone(rawPhone);
  if (!p) return false;
  const { data, error } = await supabase
    .from('disbursement_phone_blocklist')
    .select('phone_canonical')
    .eq('phone_canonical', p)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** All canonical blocked numbers (for batch filtering, e.g. pending-disbursement list). */
async function getBlockedCanonicalPhoneSet() {
  const { data, error } = await supabase.from('disbursement_phone_blocklist').select('phone_canonical');
  if (error) throw error;
  return new Set((data || []).map((r) => String(r.phone_canonical || '').trim()).filter(Boolean));
}

/** Same trimming rule as device enrollment for `device_id`. */
function normalizeDeviceIdForBlocklist(raw) {
  return raw != null ? String(raw).trim() : '';
}

function expandDeviceIdentifierCandidates(candidates) {
  const out = [];
  for (const c of candidates || []) {
    out.push({ device_id: c?.device_id, imei: c?.imei });
    if (Array.isArray(c?.imeis)) {
      for (const im of c.imeis) out.push({ device_id: c?.device_id, imei: im });
    }
  }
  return out;
}

/**
 * True if any normalized device_id or IMEI from the candidate pairs appears on disbursement_device_blocklist.
 * @param {Array<{ device_id?: string|null, imei?: string|null, imeis?: string[]|null }>} candidates
 */
async function isAnyDeviceIdentifierBlocked(candidates) {
  const deviceIds = new Set();
  const imeis = new Set();
  for (const c of expandDeviceIdentifierCandidates(candidates)) {
    const d = normalizeDeviceIdForBlocklist(c?.device_id);
    const im = normalizeImei(c?.imei);
    if (d) deviceIds.add(d);
    if (im) imeis.add(im);
  }
  if (deviceIds.size === 0 && imeis.size === 0) return false;

  if (deviceIds.size > 0) {
    const { data, error } = await supabase
      .from('disbursement_device_blocklist')
      .select('id')
      .in('device_id', [...deviceIds])
      .limit(1);
    if (error) throw error;
    if (data && data.length > 0) return true;
  }
  if (imeis.size > 0) {
    const { data, error } = await supabase
      .from('disbursement_device_blocklist')
      .select('id')
      .in('imei_canonical', [...imeis])
      .limit(1);
    if (error) throw error;
    if (data && data.length > 0) return true;
  }
  return false;
}

/**
 * Single device row from `devices` (or similar): blocked if stored device_id or imei matches list.
 * @param {{ device_id?: string|null, imei?: string|null }|null|undefined} row
 */
async function isDeviceRowBlockedForDisbursement(row) {
  if (!row) return false;
  return isAnyDeviceIdentifierBlocked([{ device_id: row.device_id, imei: row.imei }]);
}

/** Sets of blocked identifiers for batch filtering (pending-disbursement). */
async function getBlockedDeviceIdAndImeiSets() {
  const { data, error } = await supabase.from('disbursement_device_blocklist').select('device_id, imei_canonical');
  if (error) throw error;
  const deviceIds = new Set();
  const imeis = new Set();
  for (const r of data || []) {
    const d = normalizeDeviceIdForBlocklist(r.device_id);
    const im = normalizeImei(r.imei_canonical);
    if (d) deviceIds.add(d);
    if (im) imeis.add(im);
  }
  return { deviceIds, imeis };
}

module.exports = {
  isPhoneBlockedForDisbursement,
  getBlockedCanonicalPhoneSet,
  normalizeDeviceIdForBlocklist,
  isAnyDeviceIdentifierBlocked,
  isDeviceRowBlockedForDisbursement,
  getBlockedDeviceIdAndImeiSets,
};
