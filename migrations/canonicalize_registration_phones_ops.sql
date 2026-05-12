-- OPS-RUN (review before execute): normalize Tanzania MSISDN in registrations + devices
-- so lookups match server-side canonical form (255 + 9 digits).
--
-- 1. Preview duplicates per canonical line:
--    SELECT regexp_replace(trim(phone), '\s', '', 'g') AS raw,
--           CASE
--             WHEN regexp_replace(trim(phone), '\D', '', 'g') ~ '^0[0-9]{9}$'
--               THEN '255' || substr(regexp_replace(trim(phone), '\D', '', 'g'), 2)
--             ELSE regexp_replace(trim(phone), '\D', '', 'g')
--           END AS canonical_hint,
--           borrower_id
--     FROM registrations;
--
-- 2. After merging duplicate borrower rows in admin tooling (if any), update phones:

UPDATE registrations
SET phone = CASE
  WHEN regexp_replace(trim(phone), '\D', '', 'g') ~ '^0[0-9]{9}$'
    THEN '255' || substr(regexp_replace(trim(phone), '\D', '', 'g'), 2)
  WHEN regexp_replace(trim(phone), '\D', '', 'g') ~ '^255[0-9]{9}$'
    THEN regexp_replace(trim(phone), '\D', '', 'g')
  ELSE trim(phone)
END,
    updated_at = NOW()
WHERE phone IS NOT NULL AND trim(phone) <> '';

UPDATE devices
SET mpesa_phone = CASE
  WHEN mpesa_phone IS NULL OR trim(mpesa_phone) = '' THEN mpesa_phone
  WHEN regexp_replace(trim(mpesa_phone), '\D', '', 'g') ~ '^0[0-9]{9}$'
    THEN '255' || substr(regexp_replace(trim(mpesa_phone), '\D', '', 'g'), 2)
  WHEN regexp_replace(trim(mpesa_phone), '\D', '', 'g') ~ '^255[0-9]{9}$'
    THEN regexp_replace(trim(mpesa_phone), '\D', '', 'g')
  ELSE trim(mpesa_phone)
END,
    updated_at = NOW()
WHERE mpesa_phone IS NOT NULL AND trim(mpesa_phone) <> '';

-- 3. Optional uniqueness (ONLY after deduping multiple borrower_id per same canonical phone):
-- ALTER TABLE registrations ADD CONSTRAINT registrations_phone_unique UNIQUE (phone);
