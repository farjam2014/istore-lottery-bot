ALTER TABLE campaign_draws
  ADD COLUMN seed_key_id VARCHAR(64) NOT NULL DEFAULT 'legacy-env' AFTER seed_tag;
