-- Blocklist for M-Pesa / cash disbursement (canonical TZ MSISDN, same as deviceEnrollment.normalizePhone).
CREATE TABLE IF NOT EXISTS disbursement_phone_blocklist (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_canonical   TEXT NOT NULL UNIQUE,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disbursement_phone_blocklist_phone
  ON disbursement_phone_blocklist (phone_canonical);
