'use strict';

/**
 * Mixx / Yas confirmation SMS for Lipa na simu is expected to contain (case-insensitive):
 *   - "Umepokea"
 *   - "Lipa Kwa Simu" (flexible spacing between words)
 *
 * Used by lipa ingest validation and collections Lipa broad filters on `lipa_transactions.raw_sms`.
 */

function collapseWhitespace(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when text clearly looks like Mixx Lipa na simu confirmation (both markers). */
function hasMixxLipaMarkers(text) {
  const n = collapseWhitespace(text);
  if (!n) return false;
  if (!n.includes('umepokea')) return false;
  if (!n.includes('lipa kwa simu')) return false;
  return true;
}

/**
 * Best-effort body for marker checks from ingest payload (raw + concatenated).
 */
function combineSmsBodyForMarkers(rawSms, smsConcatenatedBody) {
  const a = rawSms != null ? String(rawSms).trim() : '';
  const b = smsConcatenatedBody != null ? String(smsConcatenatedBody).trim() : '';
  if (a && b && a !== b) return `${a}\n${b}`;
  return a || b || '';
}

/**
 * PostgREST AND: both substrings on `raw_sms` (ILIKE is case-insensitive).
 * Rows with null raw_sms will not match — backfill SMS or set KOPANOW_LIPA_COLLECTIONS_SKIP_MIXX_SMS_MARKERS=1.
 */
function applyRawSmsMixxMarkers(q) {
  return q.ilike('raw_sms', '%umepokea%').ilike('raw_sms', '%lipa%kwa%simu%');
}

module.exports = {
  hasMixxLipaMarkers,
  combineSmsBodyForMarkers,
  applyRawSmsMixxMarkers,
};
