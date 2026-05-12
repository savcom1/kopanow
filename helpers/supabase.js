'use strict';
const { createClient } = require('@supabase/supabase-js');

/** Trim + strip accidental wrapping quotes (common when pasting from dashboards). */
function cleanEnv(v) {
  if (v == null) return '';
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function isTruthyEnv(v) {
  const s = cleanEnv(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

if (isTruthyEnv(process.env.SUPABASE_TLS_INSECURE)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn(
    '[supabase] SUPABASE_TLS_INSECURE is enabled — TLS certificate verification is disabled for Supabase requests. Use only for local dev.',
  );
}

const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL);
/** Prefer new publishable/secret API keys (`sb_secret_*`); fall back to legacy JWT service_role. */
const SUPABASE_KEY =
  cleanEnv(process.env.SUPABASE_SECRET_KEY) || cleanEnv(process.env.SUPABASE_SERVICE_KEY);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    '[supabase] SUPABASE_URL or SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_KEY) is missing from .env',
  );
  process.exit(1);
}

/**
 * Single Supabase client for the entire backend.
 * Uses the **secret** (`sb_secret_*`) or legacy **service_role** JWT so operations bypass RLS server-side.
 * Never expose the secret to the Android app — use `SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_*`) only in trusted clients if needed.
 */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = supabase;
