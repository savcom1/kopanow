-- =====================================================================
-- Template: filter Mixx / Yas Lipa na simu rows (Umepokea + Lipa Kwa Simu)
--
-- Adjust table and column names to match your Supabase schema.
-- Common patterns: "mixx_sms_events", "MixxSmsEvents", body / message / sms_text
-- =====================================================================

-- Example: count eligible events (replace mixx_sms_events and body_column).
/*
SELECT COUNT(*)::int
FROM mixx_sms_events e
WHERE e.body_column IS NOT NULL
  AND e.body_column ILIKE '%Umepokea%'
  AND e.body_column ILIKE '%Lipa%Kwa%Simu%';
*/

-- Example: view of rows that qualify as Lipa na simu confirmation SMS
/*
CREATE OR REPLACE VIEW mixx_lipa_sms_events AS
SELECT *
FROM mixx_sms_events e
WHERE e.body_column IS NOT NULL
  AND e.body_column ILIKE '%Umepokea%'
  AND e.body_column ILIKE '%Lipa%Kwa%Simu%';
*/
