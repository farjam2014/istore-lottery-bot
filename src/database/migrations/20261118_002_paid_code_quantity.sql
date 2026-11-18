ALTER TABLE payment_orders
  ADD COLUMN requested_code_count SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER amount;

UPDATE payment_orders o
JOIN campaign_entries e ON e.id=o.campaign_entry_id
LEFT JOIN (
  SELECT campaign_entry_id,COUNT(*) AS issued_count
  FROM campaign_codes
  GROUP BY campaign_entry_id
) cc ON cc.campaign_entry_id=e.id
SET o.requested_code_count=CASE
  WHEN o.status='approved' AND cc.issued_count>0 THEN cc.issued_count
  ELSE 1
END;
