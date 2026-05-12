'use strict';

/**
 * Policy for unsupported MKOPO devices (catalog miss).
 *
 * Server must enforce this regardless of client behavior.
 */

const DEFAULT_UNSUPPORTED_PRINCIPAL_TZS = 12_000;

/**
 * If the handset has no MKOPO suggestion and this is NOT a renewal,
 * clamp principal to the minimum supported default.
 *
 * @param {number} principalTzs
 * @param {unknown} mkopoSuggestion
 * @param {boolean} isRenewal
 * @returns {number}
 */
function enforceUnsupportedMkopoDefault(principalTzs, mkopoSuggestion, isRenewal) {
  if (isRenewal) return principalTzs;
  if (mkopoSuggestion != null) return principalTzs;
  return DEFAULT_UNSUPPORTED_PRINCIPAL_TZS;
}

module.exports = {
  DEFAULT_UNSUPPORTED_PRINCIPAL_TZS,
  enforceUnsupportedMkopoDefault,
};

