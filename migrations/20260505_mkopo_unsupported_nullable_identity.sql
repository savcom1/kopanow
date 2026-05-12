-- Allow device-only telemetry rows (automatic registration reports before borrower fills name/phone).

alter table public.mkopo_unsupported_device_reports
  alter column full_name drop not null;

alter table public.mkopo_unsupported_device_reports
  alter column phone drop not null;

comment on column public.mkopo_unsupported_device_reports.full_name is
  'Borrower name when provided; null for automatic device-only catalog-gap reports.';
comment on column public.mkopo_unsupported_device_reports.phone is
  'TZ MSISDN when provided; null for automatic device-only catalog-gap reports.';
