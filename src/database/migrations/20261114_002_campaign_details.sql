ALTER TABLE campaigns
  ADD COLUMN poster_file_id VARCHAR(255) NULL AFTER description,
  ADD COLUMN prize_title VARCHAR(180) NULL AFTER poster_file_id,
  ADD COLUMN prize_description TEXT NULL AFTER prize_title,
  ADD COLUMN prize_value BIGINT UNSIGNED NULL AFTER prize_description,
  ADD COLUMN draw_at DATETIME NULL AFTER ends_at,
  ADD COLUMN terms TEXT NULL AFTER draw_at,
  ADD COLUMN payment_methods JSON NULL AFTER entry_price;
ALTER TABLE admin_wizards
  MODIFY COLUMN step ENUM('select_type','title','description','poster','prize_title','prize_description','prize_value','starts_at','ends_at','draw_at','terms','capacity','codes','price','payment_methods','confirm','payment_settings','payment_reject') NOT NULL;
