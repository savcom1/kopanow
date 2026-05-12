'use strict';

/**
 * Single shared key for ops dashboards (Admin UI, LoanOverview, and optional Accounting).
 * Set ADMIN_KEY on the host, or LOANOVERVIEW_ADMIN_KEY for backward compatibility (same value).
 */
function getExpectedAdminDashboardKey() {
  return String(process.env.LOANOVERVIEW_ADMIN_KEY || process.env.ADMIN_KEY || '').trim();
}

/** Express middleware: require x-admin-key header. */
function requireAdminDashboardAuth(req, res, next) {
  const expected = getExpectedAdminDashboardKey();
  if (!expected) {
    return res.status(500).json({
      success: false,
      error: 'Admin dashboard auth not configured (set ADMIN_KEY or LOANOVERVIEW_ADMIN_KEY)',
    });
  }
  const key = String(req.headers['x-admin-key'] || '').trim();
  if (!key || key !== expected) {
    return res.status(401).json({ success: false, error: 'Invalid or missing x-admin-key header' });
  }
  return next();
}

module.exports = {
  getExpectedAdminDashboardKey,
  requireAdminDashboardAuth,
};
