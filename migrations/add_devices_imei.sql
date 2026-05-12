-- IMEI for duplicate-enrollment detection alongside device_id (ANDROID_ID).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS imei TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_imei ON devices (imei) WHERE imei IS NOT NULL;
