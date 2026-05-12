-- Add pricing + AI-sourced retail price fields for unsupported MKOPO device reports.
-- Run in Supabase SQL editor (or psql) once.

alter table public.mkopo_unsupported_device_reports
  add column if not exists retail_price_amount numeric,
  add column if not exists retail_price_currency text,
  add column if not exists fx_rate_to_tzs numeric,
  add column if not exists retail_price_tzs numeric,
  add column if not exists mkopo_max_loan_tzs int,
  add column if not exists mkopo_first_loan_tzs int,
  add column if not exists priced_by text,
  add column if not exists priced_at timestamptz,
  add column if not exists pricing_notes text,
  add column if not exists ai_price_tzs numeric,
  add column if not exists ai_price_confidence numeric,
  add column if not exists ai_price_sources jsonb,
  add column if not exists ai_priced_at timestamptz;

comment on column public.mkopo_unsupported_device_reports.retail_price_amount is
  'Retail selling price (raw entered amount before FX).';
comment on column public.mkopo_unsupported_device_reports.retail_price_currency is
  'Currency code for retail_price_amount (e.g., TZS, USD).';
comment on column public.mkopo_unsupported_device_reports.fx_rate_to_tzs is
  'FX multiplier to convert retail_price_amount into TZS (retail_price_amount * fx_rate_to_tzs).';
comment on column public.mkopo_unsupported_device_reports.retail_price_tzs is
  'Retail price converted to TZS used for MKOPO derived amounts.';
comment on column public.mkopo_unsupported_device_reports.mkopo_max_loan_tzs is
  'Derived maximum MKOPO loan for the handset based on retail_price_tzs.';
comment on column public.mkopo_unsupported_device_reports.mkopo_first_loan_tzs is
  'Derived first/starting loan amount based on mkopo_max_loan_tzs.';
comment on column public.mkopo_unsupported_device_reports.ai_price_tzs is
  'AI/web-scraped retail price estimate in TZS (TZ retail/new).';
comment on column public.mkopo_unsupported_device_reports.ai_price_confidence is
  'Confidence score for ai_price_tzs (0..1).';
comment on column public.mkopo_unsupported_device_reports.ai_price_sources is
  'JSON array of sources used to estimate ai_price_tzs.';

