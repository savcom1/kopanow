-- Examples for ops (run in Supabase SQL editor after applying disbursement_phone_blocklist.sql).
-- Store numbers in canonical form: 255 + 9 digits (same as app/backend normalizePhone).

-- Block a line (use canonical digits only):
-- INSERT INTO disbursement_phone_blocklist (phone_canonical, note)
-- VALUES ('255744123456', 'Fraud / duplicate disbursement — do not pay out');

-- Unblock (delete by canonical key):
-- DELETE FROM disbursement_phone_blocklist WHERE phone_canonical = '255744123456';

-- List current blocklist:
-- SELECT * FROM disbursement_phone_blocklist ORDER BY created_at DESC;

-- Optional: remove pending queue rows for a blocked line (after adding to blocklist):
-- DELETE FROM cash_disbursement_queue q
-- USING registrations r
-- WHERE r.borrower_id = q.borrower_id
--   AND regexp_replace(trim(r.phone), '\D', '', 'g') IN (
--     SELECT phone_canonical FROM disbursement_phone_blocklist
--   );

-- API (with x-accounting-key when ACCOUNTING_API_SECRET is set):
-- GET    /api/accounting/disbursement-blocklist
-- POST   /api/accounting/disbursement-blocklist  JSON { "phone": "0744123456", "note": "…" }
-- DELETE /api/accounting/disbursement-blocklist?phone=255744123456
