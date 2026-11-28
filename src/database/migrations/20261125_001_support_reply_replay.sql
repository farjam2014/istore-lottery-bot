DELETE FROM support_sessions WHERE step='admin_reply';
ALTER TABLE support_sessions
  ADD COLUMN last_update_id BIGINT NULL AFTER updated_at;
