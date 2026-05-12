-- Run in Supabase SQL editor (or psql) once. Stores borrower-reported phones not in the bundled MKOPO catalog.
-- Backend uses the service role key and bypasses RLS; adjust RLS if you expose this table to anon keys.

create table if not exists public.mkopo_unsupported_device_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  borrower_id text,
  full_name text not null,
  phone text not null,
  national_id text,
  region text,
  address text,
  manufacturer text not null,
  brand text not null,
  device_model text not null,
  build_device text,
  build_product text,
  android_version text,
  sdk_version int,
  device_id text,
  imei text,
  app_version_code int,
  app_version_name text,
  client_timestamp_ms bigint
);

create index if not exists idx_mkopo_unsupported_created_at
  on public.mkopo_unsupported_device_reports (created_at desc);

create index if not exists idx_mkopo_unsupported_phone
  on public.mkopo_unsupported_device_reports (phone);

comment on table public.mkopo_unsupported_device_reports is
  'Phones reported from the Android app when no MKOPO tier matched — use for catalog updates.';
