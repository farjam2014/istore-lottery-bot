ALTER TABLE admin_search_sessions
  ADD COLUMN last_update_id BIGINT NULL;
ALTER TABLE payment_admin_sessions
  ADD COLUMN last_update_id BIGINT NULL;
