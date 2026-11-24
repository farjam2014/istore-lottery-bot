ALTER TABLE participants
  ADD COLUMN privacy_consent_version VARCHAR(40) NULL,
  ADD COLUMN privacy_consent_at DATETIME NULL,
  ADD KEY idx_participant_privacy_consent(privacy_consent_version,privacy_consent_at);
