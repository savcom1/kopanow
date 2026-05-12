'use strict';

const DEFAULT_MIN_SUPPORTED_VERSION_CODE = 6;

function minSupportedVersionCode() {
  const raw = process.env.MIN_SUPPORTED_VERSION_CODE;
  const n = raw != null ? parseInt(String(raw), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_SUPPORTED_VERSION_CODE;
}

function extractAppVersionCode(req) {
  const b = req && req.body ? req.body : {};
  const h = req && req.headers ? req.headers : {};

  const raw =
    b.app_version_code ??
    b.appVersionCode ??
    b.version_code ??
    b.versionCode ??
    h['x-app-version-code'] ??
    h['x-app-version'] ??
    null;

  if (raw == null) return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function rejectUpdateRequired(res, minCode) {
  return res.status(426).json({
    success: false,
    code: 'UPDATE_REQUIRED',
    min_supported_version_code: minCode,
    message: 'Please update the app to continue.',
  });
}

/**
 * Gate "new enrollment / new registration" endpoints.
 * If the client does not send version info, treat it as too old (blocked).
 */
function enforceMinSupportedAppVersion(req, res) {
  const minCode = minSupportedVersionCode();
  const code = extractAppVersionCode(req);
  if (!code || code < minCode) return rejectUpdateRequired(res, minCode);
  return null;
}

module.exports = {
  minSupportedVersionCode,
  extractAppVersionCode,
  enforceMinSupportedAppVersion,
};

