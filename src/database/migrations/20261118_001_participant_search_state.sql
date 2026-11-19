ALTER TABLE admin_search_sessions
  MODIFY COLUMN step ENUM('participant','participant_results','campaign_code') NOT NULL,
  ADD COLUMN query_text VARCHAR(100) NULL AFTER campaign_id;
