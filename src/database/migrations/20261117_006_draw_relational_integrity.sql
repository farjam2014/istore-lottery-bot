ALTER TABLE campaign_entries
  ADD UNIQUE KEY uq_entry_campaign_participant(id,campaign_id,participant_id);

ALTER TABLE campaign_codes
  ADD UNIQUE KEY uq_code_entry_campaign_value(id,campaign_id,campaign_entry_id,code);

ALTER TABLE draw_candidates
  ADD COLUMN campaign_entry_id BIGINT UNSIGNED NULL AFTER campaign_code_id;

UPDATE draw_candidates dc
JOIN campaign_codes cc ON cc.id=dc.campaign_code_id AND cc.campaign_id=dc.campaign_id
JOIN campaign_entries ce ON ce.id=cc.campaign_entry_id AND ce.campaign_id=cc.campaign_id
SET dc.campaign_entry_id=cc.campaign_entry_id,
    dc.campaign_id=cc.campaign_id,
    dc.participant_id=ce.participant_id,
    dc.code_snapshot=cc.code
WHERE dc.campaign_entry_id IS NULL
   OR dc.campaign_id IS NULL
   OR dc.participant_id IS NULL
   OR dc.code_snapshot IS NULL;

ALTER TABLE draw_candidates
  MODIFY campaign_entry_id BIGINT UNSIGNED NOT NULL,
  MODIFY campaign_id BIGINT UNSIGNED NOT NULL,
  MODIFY participant_id BIGINT UNSIGNED NOT NULL,
  MODIFY code_snapshot VARCHAR(32) NOT NULL,
  ADD UNIQUE KEY uq_candidate_full_identity(id,draw_id,campaign_id,campaign_code_id,campaign_entry_id,participant_id,code_snapshot),
  ADD CONSTRAINT fk_candidate_entry_participant
    FOREIGN KEY(campaign_entry_id,campaign_id,participant_id)
    REFERENCES campaign_entries(id,campaign_id,participant_id),
  ADD CONSTRAINT fk_candidate_code_entry_value
    FOREIGN KEY(campaign_code_id,campaign_id,campaign_entry_id,code_snapshot)
    REFERENCES campaign_codes(id,campaign_id,campaign_entry_id,code);

ALTER TABLE draw_winners
  ADD COLUMN campaign_entry_id BIGINT UNSIGNED NULL AFTER campaign_code_id;

UPDATE draw_winners w
JOIN draw_candidates dc
  ON dc.id=w.candidate_id
 AND dc.draw_id=w.draw_id
 AND dc.campaign_id=w.campaign_id
 AND dc.campaign_code_id=w.campaign_code_id
 AND dc.participant_id=w.participant_id
 AND dc.code_snapshot=w.code_snapshot
SET w.campaign_entry_id=dc.campaign_entry_id
WHERE w.campaign_entry_id IS NULL;

ALTER TABLE draw_winners
  MODIFY campaign_id BIGINT UNSIGNED NOT NULL,
  MODIFY participant_id BIGINT UNSIGNED NOT NULL,
  MODIFY candidate_id BIGINT UNSIGNED NOT NULL,
  MODIFY campaign_entry_id BIGINT UNSIGNED NOT NULL,
  MODIFY code_snapshot VARCHAR(32) NOT NULL,
  ADD CONSTRAINT fk_winner_exact_candidate
    FOREIGN KEY(candidate_id,draw_id,campaign_id,campaign_code_id,campaign_entry_id,participant_id,code_snapshot)
    REFERENCES draw_candidates(id,draw_id,campaign_id,campaign_code_id,campaign_entry_id,participant_id,code_snapshot);
