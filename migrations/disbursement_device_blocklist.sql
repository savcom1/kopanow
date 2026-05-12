-- Blocks device_id and/or IMEI from cash_disbursement_queue (heartbeat) and confirm-cash-disbursement.
-- Apply in Supabase SQL editor or via migration runner.

CREATE TABLE IF NOT EXISTS public.disbursement_device_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text,
  imei_canonical text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disbursement_device_blocklist_some_id CHECK (
    (device_id IS NOT NULL AND btrim(device_id) <> '')
    OR (imei_canonical IS NOT NULL AND btrim(imei_canonical) <> '')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS disbursement_device_blocklist_device_id_uq
  ON public.disbursement_device_blocklist (device_id)
  WHERE device_id IS NOT NULL AND btrim(device_id) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS disbursement_device_blocklist_imei_uq
  ON public.disbursement_device_blocklist (imei_canonical)
  WHERE imei_canonical IS NOT NULL AND btrim(imei_canonical) <> '';

COMMENT ON TABLE public.disbursement_device_blocklist IS
  'Ops blocklist: matching device_id or IMEI cannot enqueue to cash_disbursement_queue or confirm cash disbursement.';
