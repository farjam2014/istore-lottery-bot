-- Admin audit records are evidence of sensitive operations and must not be mutable
-- by the runtime database account. The runtime account has DML privileges on the
-- application schema, so enforce append-only behavior at the database boundary.
CREATE TRIGGER trg_admin_audit_log_no_update
BEFORE UPDATE ON admin_audit_log
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'admin_audit_log is append-only';

CREATE TRIGGER trg_admin_audit_log_no_delete
BEFORE DELETE ON admin_audit_log
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'admin_audit_log is append-only';
