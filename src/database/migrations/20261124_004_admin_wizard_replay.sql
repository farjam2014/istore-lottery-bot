ALTER TABLE admin_wizards
  ADD COLUMN last_update_id BIGINT NULL;

ALTER TABLE payment_card_admin_sessions
  ADD COLUMN last_update_id BIGINT NULL;

ALTER TABLE admin_role_sessions
  ADD COLUMN last_update_id BIGINT NULL;

DELETE FROM admin_role_sessions;
