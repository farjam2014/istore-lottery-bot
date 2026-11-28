DELETE FROM support_sessions WHERE last_update_id IS NULL;
ALTER TABLE profile_change_sessions
  ADD COLUMN last_update_id BIGINT NULL;
DELETE FROM profile_change_sessions;
