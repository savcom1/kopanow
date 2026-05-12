-- All readable SIM-slot IMEIs (primary remains in devices.imei).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS imeis jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS devices_imeis_gin_idx
  ON devices USING gin (imeis);
