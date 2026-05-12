-- LoanOverview: completed disbursements vs people vs repeat (2nd+ loan per borrower).

SELECT
  COUNT(*) AS completed_loans,
  COUNT(DISTINCT loan_id) AS distinct_loans,
  COUNT(DISTINCT borrower_id) AS distinct_borrowers
FROM cash_disbursement_queue
WHERE status = 'completed';

WITH ranked AS (
  SELECT
    loan_id,
    borrower_id,
    ROW_NUMBER() OVER (
      PARTITION BY borrower_id
      ORDER BY updated_at NULLS LAST, loan_id
    ) AS n
  FROM cash_disbursement_queue
  WHERE status = 'completed'
    AND borrower_id IS NOT NULL
    AND btrim(borrower_id) <> ''
)
SELECT
  COUNT(*) FILTER (WHERE n = 1) AS first_time_loans,
  COUNT(*) FILTER (WHERE n > 1) AS repeat_disbursement_loans
FROM ranked;
