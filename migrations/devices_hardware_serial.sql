-- Hardware serial captured during onboarding step 8 (anti-repeat alongside device_id / imei).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hardware_serial text;

CREATE INDEX IF NOT EXISTS devices_hardware_serial_idx
  ON devices (hardware_serial)
  WHERE hardware_serial IS NOT NULL;
