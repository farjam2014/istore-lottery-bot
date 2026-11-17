ALTER TABLE campaign_draws
  ADD COLUMN commitment_publication_reference VARCHAR(500) NULL AFTER candidate_snapshot_hash,
  ADD COLUMN commitment_published_at DATETIME NULL AFTER commitment_publication_reference,
  ADD COLUMN commitment_published_by BIGINT NULL AFTER commitment_published_at;

-- Preserve every existing wizard step; only append the publication workflow steps.
ALTER TABLE admin_wizards
  MODIFY COLUMN step ENUM(
    'select_type','title','description','poster','prize_title','prize_description',
    'prize_value','starts_at','ends_at','draw_at','terms','capacity','codes',
    'price','payment_methods','confirm','payment_settings','payment_reject',
    'draw_publication_reference','draw_publication_confirm'
  ) NOT NULL;