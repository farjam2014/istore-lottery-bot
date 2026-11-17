ALTER TABLE admin_search_sessions
  MODIFY COLUMN step ENUM('participant','campaign_code') NOT NULL,
  ADD COLUMN campaign_id BIGINT UNSIGNED NULL AFTER step,
  ADD KEY idx_admin_search_campaign(campaign_id),
  ADD CONSTRAINT fk_admin_search_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;
