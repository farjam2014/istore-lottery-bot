ALTER TABLE campaign_draws
  ADD COLUMN winner_count SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER candidate_count,
  ADD COLUMN seed_ciphertext TEXT NULL AFTER seed_hash,
  ADD COLUMN seed_nonce CHAR(24) NULL AFTER seed_ciphertext,
  ADD COLUMN seed_tag CHAR(32) NULL AFTER seed_nonce,
  ADD COLUMN revealed_seed CHAR(64) NULL AFTER seed_tag,
  ADD COLUMN candidate_snapshot_hash CHAR(64) NULL AFTER revealed_seed,
  ADD UNIQUE KEY uq_draw_id_campaign(id,campaign_id);

ALTER TABLE campaign_codes
  ADD UNIQUE KEY uq_campaign_code_id_campaign(id,campaign_id);

ALTER TABLE draw_candidates
  ADD COLUMN campaign_id BIGINT UNSIGNED NULL AFTER draw_id,
  ADD COLUMN participant_id BIGINT UNSIGNED NULL AFTER campaign_id,
  ADD COLUMN code_snapshot VARCHAR(32) NULL AFTER participant_id,
  ADD UNIQUE KEY uq_draw_candidate_campaign(draw_id,campaign_id,campaign_code_id),
  ADD CONSTRAINT fk_candidate_draw_campaign FOREIGN KEY(draw_id,campaign_id) REFERENCES campaign_draws(id,campaign_id),
  ADD CONSTRAINT fk_candidate_code_campaign FOREIGN KEY(campaign_code_id,campaign_id) REFERENCES campaign_codes(id,campaign_id),
  ADD CONSTRAINT fk_candidate_participant FOREIGN KEY(participant_id) REFERENCES participants(id);

ALTER TABLE draw_winners
  ADD COLUMN campaign_id BIGINT UNSIGNED NULL AFTER draw_id,
  ADD COLUMN participant_id BIGINT UNSIGNED NULL AFTER campaign_id,
  ADD COLUMN candidate_id BIGINT UNSIGNED NULL AFTER participant_id,
  ADD COLUMN code_snapshot VARCHAR(32) NULL AFTER candidate_id,
  ADD UNIQUE KEY uq_draw_winner_participant(draw_id,participant_id),
  ADD CONSTRAINT fk_winner_draw_campaign FOREIGN KEY(draw_id,campaign_id) REFERENCES campaign_draws(id,campaign_id),
  ADD CONSTRAINT fk_winner_candidate FOREIGN KEY(candidate_id) REFERENCES draw_candidates(id),
  ADD CONSTRAINT fk_winner_code_campaign FOREIGN KEY(campaign_code_id,campaign_id) REFERENCES campaign_codes(id,campaign_id),
  ADD CONSTRAINT fk_winner_participant FOREIGN KEY(participant_id) REFERENCES participants(id);
