ALTER TABLE admin_wizards
  ADD COLUMN last_update_id BIGINT NULL;

ALTER TABLE payment_card_admin_sessions
  ADD COLUMN last_update_id BIGINT NULL;

ALTER TABLE admin_role_sessions
  ADD COLUMN last_update_id BIGINT NULL;

-- Pre-cursor text sessions cannot be safely distinguished from delayed inbox updates.
DELETE FROM admin_wizards WHERE last_update_id IS NULL;

DELETE FROM payment_card_admin_sessions WHERE last_update_id IS NULL;

DELETE FROM admin_role_sessions WHERE last_update_id IS NULL;
