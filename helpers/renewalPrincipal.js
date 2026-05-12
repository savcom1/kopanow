'use strict';

const RENEWAL_PRINCIPAL_MULTIPLIER = 1.15;

/**
 * @param {unknown} prevPrincipal
 * @param {{ amountTzsRounded: number, amountMaxTzsRounded?: number, label?: string } | null | undefined} mkopoSuggestion
 * @returns {{ principal: number, principal_multiplier: number, computedBeforeClamp: number } | null}
 */
function applyRenewalPrincipalPolicy(prevPrincipal, mkopoSuggestion) {
  const prev = Number(prevPrincipal);
  if (!Number.isFinite(prev) || prev <= 0) return null;
  const computedBeforeClamp = Math.round(prev * RENEWAL_PRINCIPAL_MULTIPLIER);
  if (!mkopoSuggestion) {
    return {
      principal: computedBeforeClamp,
      principal_multiplier: RENEWAL_PRINCIPAL_MULTIPLIER,
      computedBeforeClamp,
    };
  }
  const min = mkopoSuggestion.amountTzsRounded;
  const max = mkopoSuggestion.amountMaxTzsRounded ?? min;
  const principal = Math.max(min, Math.min(computedBeforeClamp, max));
  return {
    principal,
    principal_multiplier: RENEWAL_PRINCIPAL_MULTIPLIER,
    computedBeforeClamp,
  };
}

/**
 * Map a `devices` row (previous loan) to resolveMkopoForDevice inputs.
 * @param {{ device_model?: string | null, device_info?: Record<string, unknown> | null } | null | undefined} prevDevice
 */
function mkopoArgsFromDeviceRow(prevDevice) {
  if (!prevDevice) {
    return { manufacturer: '', brand: '', model: '', device: '' };
  }
  const info =
    prevDevice.device_info && typeof prevDevice.device_info === 'object' ? prevDevice.device_info : {};
  const manufacturer = info.manufacturer != null ? String(info.manufacturer) : '';
  const brand = info.brand != null ? String(info.brand) : '';
  const model =
    (info.device_model_raw != null ? String(info.device_model_raw) : '') ||
    (prevDevice.device_model != null ? String(prevDevice.device_model) : '') ||
    '';
  const device = info.build_device != null ? String(info.build_device) : '';
  return { manufacturer, brand, model, device };
}

module.exports = {
  applyRenewalPrincipalPolicy,
  mkopoArgsFromDeviceRow,
  RENEWAL_PRINCIPAL_MULTIPLIER,
};
