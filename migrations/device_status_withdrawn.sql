-- Voluntary in-app "futa programu" during onboarding: POST /api/device/status with withdrawn.
-- LoanOverview excludes loans.device_status = 'withdrawn' from applicant counts.

ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_device_status_check;
ALTER TABLE loans ADD CONSTRAINT loans_device_status_check CHECK (device_status IN (
  'unregistered','registered','active','locked',
  'admin_removed','suspended','withdrawn','paid'
));

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_status_check;
ALTER TABLE devices ADD CONSTRAINT devices_status_check CHECK (status IN (
  'registered','active','locked','admin_removed','suspended','withdrawn'
));
