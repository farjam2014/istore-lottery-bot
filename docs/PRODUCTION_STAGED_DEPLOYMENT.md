# Production staged deployment runbook

This procedure is for the existing release-directory production host. **No active release path is assumed by this runbook.** The path, process working directory, and deployed commit must be discovered read-only from the live host immediately before the maintenance window. Do not copy a path from an earlier audit or assume a release-directory name is still active.

It is a **manual, approval-gated deployment plan**. It has not been executed. Use the exact reviewed and merged release commit SHA, never a floating branch.

## Safety rules

- Do not run the installer against the current host.
- Do not print, upload, or paste `.env`, Telegram bot token, MySQL password, or draw encryption keys.
- Never run two long-polling processes with the same bot token.
- Do not apply migrations before a verified database backup and independent draw-key backup.
- If a migration fails, stop and inspect; do not blindly rerun or manually drop objects.
- Keep the old release directory intact until acceptance is complete.
- A code rollback after migrations is not automatically safe. Verify schema compatibility first.

## 1. Record the current target (read-only)

```bash
sudo systemctl show ustore-telegram-bot.service \
  -p ActiveState -p SubState -p User -p ExecStart -p WorkingDirectory

ACTIVE="$(sudo systemctl show ustore-telegram-bot.service -p WorkingDirectory --value)"
printf 'Active release path: %s\n' "$ACTIVE"
sudo test -f "$ACTIVE/.env"
sudo stat -c '%U %a %n' "$ACTIVE/.env"
```

Record the active path, unit file, service state, and exact database migration history. Do not display environment values.

## 2. Create protected backups

Choose a timestamped backup directory on a protected filesystem:

```bash
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/ustore-release-backup-$STAMP"
sudo install -d -m 700 "$BACKUP_DIR"
```

Obtain `MYSQL_DATABASE` from the protected environment without printing the rest of `.env`. Stream the approved consistent dump through compression and encryption into the protected backup directory; do not leave a plaintext or compression-only SQL dump on disk. Verify the encrypted archive and record its SHA-256. Keep an independently encrypted off-host copy. The read-only host preflight requires at least one encrypted database-backup artifact and `plaintext_database_backup_artifacts=0`; remove or re-encrypt legacy plaintext dumps before proceeding.

Back up the exact draw-key configuration/key IDs independently in an access-controlled encrypted vault. Preserve the current `.env` as a root-only recovery artifact, encrypted before off-host storage. A database dump without the historical draw keys is not a complete draw recovery backup.

Restore the backup into a separate disposable database and verify table counts and the prepared-draw/key decryption check before proceeding.

## 3. Stage the exact release

Set `TARGET_SHA` to the exact merged release commit and `TARGET_RELEASE` to a new directory under `/opt/ustore-releases`. Do not reuse or overwrite the active release.

- Clone/fetch the repository at `TARGET_SHA`.
- Copy the protected runtime `.env` from the active release into the new release; it must contain only the restricted runtime `MYSQL_USER`/`MYSQL_PASSWORD`.
- Keep migration credentials outside the release and outside the service environment in `/etc/ustore-telegram-bot/ustore-telegram-bot-migration.env`, owned by `root:root`, parent directory mode `700`, file mode `600`. Never copy this file into the release or expose its values to the systemd service.
- Set owner to `ustorebot:ustorebot` and mode `600` on the runtime `.env`.
- Install locked production dependencies with `npm ci --omit=dev`.
- Run the non-production test suite and JavaScript syntax checks from the staged directory. Do not set `RUN_MYSQL_TESTS=1` against the production database.
- Record the target SHA and the staged file inventory.

## 4. Read-only production preflight

From the staged candidate release (or a clean checkout of the exact Candidate commit), run `sudo bash scripts/production-host-preflight.sh` and retain its output in the private deployment audit. The script resolves `dotenv` from the active release, so the audit checkout does not need dependency installation. It reports service identity/path, runtime and migration database-grant summaries (including granted roles, alternate host identities, and proxy grants), self-hosted runner service/unit-file/registration-metadata and no-sudo/helper ownership state, timer/cron backup evidence, draw-key backup metadata, encrypted database-backup artifacts, and network/firewall metadata. It also requires a valid HTTPS PRIVACY_NOTICE_URL and PRIVACY_NOTICE_VERSION in the active runtime environment and checks that the URL is reachable over HTTPS without allowing an HTTP redirect; this gate runs before any service stop. It does not print environment values or secret material and does not change host state. A non-zero exit is a release blocker; remediate the reported host controls and re-run it. Separately verify in GitHub repository Settings → Actions → Runners that no self-hosted runner remains registered; host-side inspection cannot prove the remote registration list is empty.

Then run `scripts/production-migration-preflight.sql` from the staged release against the exact production database using a read-only account. Retain the output.

Stop release preparation if it reports any of the following:

- code/entry campaign ownership mismatches;
- sequence overflow;
- existing draw candidates or winners that block migration 006;
- prepared draw rows requiring historical review. This baseline phase reports draw IDs/status/commitment only; ciphertext, nonce, tag, and keyring metadata are checked in the post-migration phase below;
- unexpected migration history or missing required schema;
- migration checksum disagreement;
- any replay-session cleanup result marked `PENDING_OR_MISSING_TABLE`;
- any non-zero cleanup or retained-but-cursorless session count unless the affected flows, customer impact, and support handling have been explicitly reviewed and approved by the business owner.

The preflight reports exact row counts for six session tables whose rows are intentionally cleared (registration, admin wizard, payment-card, admin-role, support, and profile-change), plus `admin_search_sessions` and `payment_admin_sessions`, whose legacy rows are retained but receive NULL cursors and are rejected by replay guards. It also reports a support-session step breakdown for the `admin_reply` subset. Preserve this output with the release evidence. These counts are an impact inventory, not automatic authorization to delete the rows. It additionally emits aggregate-only counts for raw Telegram inbox records and admin idempotency records, plus participant privacy-consent version/timestamp states; it never selects raw inbox payloads or participant identifiers.

Reconcile the exact target database and key inventory before any write.

**Migration execution boundary:** Never execute any file under `src/database/migrations/` directly with the MySQL client, Workbench, or an ad-hoc SQL session. Those files are ordered inputs to `src/database/migrate.js`; direct execution bypasses the runner's migration-history, checksum, and data precondition guards. This is especially important for `20261117_006_draw_relational_integrity.sql`: the runner must verify that both legacy draw tables are empty before the first migration DDL. If the preflight finds any draw candidate or winner, stop. Do not delete those rows, hand-edit the migration, or run its backfill manually; preserve the evidence and prepare a separately reviewed reconciliation plan.

## 5. Approved maintenance window

Before applying the replay-cursor migrations, announce a short maintenance window. Pre-cursor in-progress registration, pending receipt-upload, participant support/profile, and admin text-wizard sessions are intentionally cleared because they cannot be safely associated with a Telegram Update ID. Existing admin participant-search and payment-order-search sessions are not deleted, but their new replay cursors are NULL. Text-message continuations for those legacy searches are rejected as stale; existing participant-result pagination callbacks may continue to use the retained query state until the normal 24-hour cleanup. Existing participant profiles, submitted payment receipts, payment orders, and issued raffle codes are not deleted by these session-cleanup statements. Users with an interrupted receipt-upload flow may need to resend the receipt after service recovery.

Only after separate approval:

1. Announce maintenance and prevent new registration/payment writes.
2. Stop the active service and confirm it is stopped. Do not start the staged release yet.
3. **Re-run the complete read-only preflight after the service is stopped**, against the exact target database. Preserve this final output, compare migration history/schema/business row counts with the earlier preflight, and re-check all eight session-impact counts. Stop if anything changed unexpectedly, any table is reported as pending/missing, or a non-zero cleanup/cursorless-session count lacks explicit business-owner approval. This stopped-service inventory is the final data-impact baseline for the migration window.
4. Verify the root-only migration credential file and its exact target database. Run the migration command as root from the staged release. The shell must export both the runtime database identity (read from the active release `.env`) and the separately protected migration credentials to the migration process, without printing either file or enabling shell tracing. Use this exact pattern:

   ```bash
   set -Eeuo pipefail
   set +x
   trap 'unset MYSQL_DATABASE MYSQL_MIGRATION_USER MYSQL_MIGRATION_PASSWORD MIGRATION_TARGET_DATABASE' EXIT
   ACTIVE="$(systemctl show ustore-telegram-bot.service -p WorkingDirectory --value)"
   SERVICE_USER="$(systemctl show ustore-telegram-bot.service -p User --value)"
   test -n "$ACTIVE" && test -n "$SERVICE_USER"
   test -f "$ACTIVE/.env" && test ! -L "$ACTIVE/.env"
   test "$(stat -c '%U' "$ACTIVE/.env")" = "$SERVICE_USER"
   test "$(stat -c '%a' "$ACTIVE/.env")" = 600
   MYSQL_DATABASE="$(node --input-type=module -e "import dotenv from 'dotenv'; import {readFileSync} from 'node:fs'; const parsed=dotenv.parse(readFileSync(process.argv[1])); process.stdout.write(parsed.MYSQL_DATABASE ?? '');" "$ACTIVE/.env")"
   [[ "$MYSQL_DATABASE" =~ ^[A-Za-z0-9_]{1,64}$ ]]
   export MYSQL_DATABASE
   MIGRATION_ENV_DIR="/etc/ustore-telegram-bot"
   MIGRATION_ENV="$MIGRATION_ENV_DIR/ustore-telegram-bot-migration.env"
   test -d "$MIGRATION_ENV_DIR" && test ! -L "$MIGRATION_ENV_DIR"
   test "$(stat -c '%U' "$MIGRATION_ENV_DIR")" = root
   test "$(stat -c '%a' "$MIGRATION_ENV_DIR")" = 700
   test -f "$MIGRATION_ENV" && test ! -L "$MIGRATION_ENV"
   test "$(stat -c '%U' "$MIGRATION_ENV")" = root
   test "$(stat -c '%a' "$MIGRATION_ENV")" = 600
   set -a
   . "$MIGRATION_ENV"
   set +a
   [[ "$MYSQL_MIGRATION_USER" =~ ^[A-Za-z0-9_]{1,32}$ ]]
   [[ "$MIGRATION_TARGET_DATABASE" =~ ^[A-Za-z0-9_]{1,64}$ ]]
   test "$MYSQL_DATABASE" = "$MIGRATION_TARGET_DATABASE"
   MIGRATION_SCHEMA_PRIVILEGES="$(mysql --protocol=socket -NBe "SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MYSQL_MIGRATION_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$MYSQL_DATABASE' AND PRIVILEGE_TYPE IN ('SELECT','INSERT','UPDATE','DELETE','CREATE','ALTER','INDEX','REFERENCES','TRIGGER')")"
   MIGRATION_SCHEMA_PRIVILEGE_ROWS="$(mysql --protocol=socket -NBe "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MYSQL_MIGRATION_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA='$MYSQL_DATABASE'")"
   MIGRATION_GLOBAL_PRIVILEGES="$(mysql --protocol=socket -NBe "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MYSQL_MIGRATION_USER'),'@',QUOTE('127.0.0.1')) AND PRIVILEGE_TYPE<>'USAGE'")"
   MIGRATION_OTHER_SCHEMA_PRIVILEGES="$(mysql --protocol=socket -NBe "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MYSQL_MIGRATION_USER'),'@',QUOTE('127.0.0.1')) AND TABLE_SCHEMA<>'$MYSQL_DATABASE'")"
   MIGRATION_TABLE_PRIVILEGES="$(mysql --protocol=socket -NBe "SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE('$MYSQL_MIGRATION_USER'),'@',QUOTE('127.0.0.1'))")"
   test "$MIGRATION_SCHEMA_PRIVILEGES" = 9
   test "$MIGRATION_SCHEMA_PRIVILEGE_ROWS" = 9
   test "$MIGRATION_GLOBAL_PRIVILEGES" = 0
   test "$MIGRATION_OTHER_SCHEMA_PRIVILEGES" = 0
   test "$MIGRATION_TABLE_PRIVILEGES" = 0
   ALLOW_DATABASE_MIGRATIONS=1 ALLOW_PRODUCTION_MIGRATIONS=1 npm run db:migrate
   AUDIT_TRIGGER_COUNT="$(mysql --protocol=socket --database="$MYSQL_DATABASE" -NBe "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('trg_admin_audit_log_no_update','trg_admin_audit_log_no_delete') AND EVENT_OBJECT_TABLE='admin_audit_log' AND ACTION_TIMING='BEFORE' AND ((TRIGGER_NAME='trg_admin_audit_log_no_update' AND EVENT_MANIPULATION='UPDATE') OR (TRIGGER_NAME='trg_admin_audit_log_no_delete' AND EVENT_MANIPULATION='DELETE')) AND UPPER(REGEXP_REPLACE(TRIM(ACTION_STATEMENT), '[[:space:]]+', ' '))=CONCAT('SIGNAL SQLSTATE ',CHAR(39),'45000',CHAR(39),' SET MESSAGE_TEXT = ',CHAR(39),'ADMIN_AUDIT_LOG IS APPEND-ONLY',CHAR(39))")"
   test "$AUDIT_TRIGGER_COUNT" = 2
   ```

   Run this only as root, from the staged release, after the separately approved maintenance and backup gates. The protected file must set `MYSQL_MIGRATION_USER`, `MYSQL_MIGRATION_PASSWORD`, and `MIGRATION_TARGET_DATABASE`; the migration guard compares the latter to `MYSQL_DATABASE` loaded from the runtime `.env`. Never run the command with `set -x`.
5. If a migration fails, keep the service stopped and follow the failure/restore decision tree. Never automatically restore a backup after new writes have occurred.
6. After all migrations complete successfully, run `scripts/post-migration-integrity-check.sql` against the same target database using a dedicated SELECT-only MySQL account, not the migration account. Retain all four result sets. Stop if any prepared draw reports MISSING, MISSING_OR_INVALID, or UNSUPPORTED metadata; compare every returned key ID with the protected keyring inventory and the independent decrypt/restore rehearsal. Any counter-drift or duplicate-sequence row is also a release blocker.
7. Inspect `SHOW GRANTS` for the runtime `MYSQL_USER` from the protected runtime environment. It must have only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the target application schema, with no global privileges, DDL privileges, or grants on other schemas. If it has broader grants, use the MySQL administrative account to revoke all grants and re-grant only those four DML privileges on the target schema; then re-run `SHOW GRANTS`. Keep the DDL-capable migration account separate and unreadable by the service user.
8. Capture migration and post-migration outputs and verify `schema_migrations` checksums and expected schema before enabling application traffic.

## 6. Point systemd at the staged release

Back up the existing unit file and create a systemd drop-in that sets the staged release's:

- `WorkingDirectory`
- `ExecStart` (clear the previous ExecStart first)
- `ReadWritePaths` (clear the previous path list, then set the new release path)

Then run `systemctl daemon-reload`, start the service, and confirm:

- `ActiveState=active`, `SubState=running`, nonzero `MainPID`;
- journal contains `Telegram bot launched with long polling`;
- no restart loop, fatal startup error, migration error, or Telegram polling conflict.

Do not start the old and new releases simultaneously.

## 7. Smoke test and acceptance

Run read-only/low-impact checks first:

- `/start` and participant menu;
- super-admin `/admin` access and system-health view;
- campaign list/details;
- outbox and Telegram inbox status/retry visibility;
- service logs and MySQL connectivity.

Do not create a real payment, issue production codes, close a campaign, prepare/complete a draw, or export personal data as a smoke test without explicit test-data and production-write approval.

Complete the remaining fresh-server acceptance and backup/key recovery rehearsal on a disposable environment. Production launch is blocked until every P0/P1 finding is closed and the evidence is recorded.

## 8. Rollback

- Before migrations: restore the previous unit path and start the old release.
- After migrations but before traffic: do not assume old code is compatible. Prefer a forward fix. Restoring the database is allowed only after a verified backup/key restore and a decision that no post-backup writes will be lost.
- After the new version accepts writes: never restore the pre-deployment database blindly. Preserve all new writes and prefer a forward fix. Code rollback requires a compatibility review of the migrated schema and code-issued sequence counters.

This runbook does not authorize deployment, migration, service restart, or production writes.
