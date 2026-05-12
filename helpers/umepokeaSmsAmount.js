'use strict';

/**
 * Parse the received amount from Mixx-style Lipa SMS that contains "Umepokea".
 * Returns null if there is no Umepokea marker or no parseable amount (caller may use DB column).
 */

function normalizeMoneyToken(token) {
  if (token == null) return null;
  const s = String(token).replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {string|null|undefined} rawSms
 * @returns {number|null}
 */
function parseAmountFromUmepokeaSms(rawSms) {
  if (rawSms == null) return null;
  const text = String(rawSms);
  const lower = text.toLowerCase();
  // Common wording: "Umepokea" (Mixx); some handsets use "Umepokia".
  const marker = /umepokea|umepokia/i.exec(text);
  if (!marker) return null;

  const tail = text.slice(marker.index);

  // Prefer explicit currency labels (TZS / TSh) immediately after Umepokea region.
  // One token: digits with optional thousands commas and optional decimals (avoid {1,3} eating "250" from "25000").
  const curRe = /(?:TZS|TSh|TSH)\s*([\d,]+(?:\.\d+)?)/gi;
  let m;
  while ((m = curRe.exec(tail)) !== null) {
    const n = normalizeMoneyToken(m[1]);
    if (n != null) return n;
  }

  // Fallback: first money-like token in a short window after Umepokea (avoid tiny refs).
  const window = tail.slice(0, 160);
  const loose = window.match(/([\d]{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,}(?:\.\d{1,2})?)/);
  if (loose) {
    const n = normalizeMoneyToken(loose[1]);
    if (n != null && n >= 10) return n;
  }

  return null;
}

module.exports = {
  parseAmountFromUmepokeaSms,
};
