ALTER TABLE telegram_user_sessions
  ADD COLUMN last_update_id BIGINT NULL;

-- Existing registration sessions predate durable update cursors. They cannot
-- be safely distinguished from delayed inbox messages after this migration.
DELETE FROM telegram_user_sessions WHERE last_update_id IS NULL;
