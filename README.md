# UStore Telegram Bot

Telegram-native campaign bot for private chats. This release does not use Telegram Business and does not include a web administration panel.

Requires Node.js 22+, MySQL 8+, and a Telegram bot token.

## Current product scope

- Persistent participant profile (name, Telegram-shared phone contact, Instagram handle).
- Inline Telegram menus and campaign operations.
- Free campaign entry with capacity enforcement, profile snapshots and unique entry codes. New campaign codes use P{campaignId}-{six-character-middle}-{two-character-suffix}; the middle segment's rightmost digits are a per-campaign sequence beginning at 1 and ending at 999999.
- Paid-order, receipt-review and code-issuance services are present; paid campaigns must remain disabled until the end-to-end customer/admin flow is verified against the target database and bot.
- Campaign draws use a committed random seed, an immutable candidate snapshot, deterministic HMAC-SHA256 ranking, encrypted seed storage before execution, and a revealed seed after completion. Draw actions require the dedicated campaign.draw permission (super-admin by default).
- Live payment-gateway integration remains deferred; bank-transfer receipt review is manual.
- Administration is inside Telegram. There is no web-panel password.

## Reliability and privacy controls

- Polling startup detects and removes a stale Telegram webhook without discarding pending updates.
- Telegram update IDs are claimed idempotently through a durable inbox; database-backed per-user rate limits are applied to text, callback and other updates.
- Inbox payloads contain the Telegram Update needed for replay. Completed payloads are retained for three days; pending, failed and stale-processing payloads are purged after thirty days. This retention window requires an approved privacy policy.
- Correlation IDs are carried through async logs, processed-update rows, payment events, audit records and queued notifications.
- Notification delivery uses a leased outbox with bounded automatic retries. Failed and uncertain deliveries can be retried manually from the super-admin health screen; uncertain retries explicitly warn that duplicates are possible.
- Bank-card details are snapshotted per order, and successful presentation to a participant is recorded in the payment event history using only the card's last four digits.
- Production requires a published HTTPS privacy notice and explicit acceptance before collecting participant data.

See docs/COMPLETION_SCOPE.md for product invariants, docs/VERIFIABLE_DRAWS.md for the proof format and limitations, docs/PRIVACY_AND_RETENTION.md for data handling, and docs/RELEASE_READINESS.md for release gates and rollback.

## Tests

Install locked dependencies with npm ci, then run npm test.

MySQL integration tests use a disposable local MySQL 8 instance. They require separate runtime, migration, backup, restore, restored-runtime, fixture-admin, and read-only identities. Never point them at Production or reuse Production credentials.

Example isolated setup (run from the repository root; use a local MySQL instance and a database name different from the one in .env):

```bash
export MYSQL_TEST_DATABASE=istore_lottery_local_ci
export MYSQL_RESTORE_DATABASE=draw_restore_local_ci
export MYSQL_PREFLIGHT_DATABASE=ustore_preflight_local_ci
export MYSQL_DRAW_GUARD_DATABASE=ustore_drawguard_local_ci

export MYSQL_TEST_USER=ustore_ci_testapp
export MYSQL_MIGRATION_USER=ustore_ci_migrate
export MYSQL_BACKUP_USER=ustore_ci_backup
export MYSQL_RESTORE_USER=ustore_ci_restore
export MYSQL_RESTORE_RUNTIME_USER=ustore_ci_restore_runtime
export MYSQL_TEST_ADMIN_USER=ustore_ci_admin
export MYSQL_TEST_READONLY_USER=ustore_ci_readonly

export MYSQL_TEST_PASSWORD="$(openssl rand -hex 32)"
export MYSQL_MIGRATION_PASSWORD="$(openssl rand -hex 32)"
export MYSQL_BACKUP_PASSWORD="$(openssl rand -hex 32)"
export MYSQL_RESTORE_PASSWORD="$(openssl rand -hex 32)"
export MYSQL_RESTORE_RUNTIME_PASSWORD="$(openssl rand -hex 32)"
export MYSQL_TEST_ADMIN_PASSWORD="$(openssl rand -hex 32)"
export MYSQL_TEST_READONLY_PASSWORD="$(openssl rand -hex 32)"
export DRAW_SEED_ENCRYPTION_KEY="$(openssl rand -hex 32)"

sudo --preserve-env=MYSQL_TEST_DATABASE,MYSQL_RESTORE_DATABASE,MYSQL_PREFLIGHT_DATABASE,MYSQL_DRAW_GUARD_DATABASE,MYSQL_TEST_USER,MYSQL_MIGRATION_USER,MYSQL_BACKUP_USER,MYSQL_RESTORE_USER,MYSQL_RESTORE_RUNTIME_USER,MYSQL_TEST_ADMIN_USER,MYSQL_TEST_READONLY_USER,MYSQL_TEST_PASSWORD,MYSQL_MIGRATION_PASSWORD,MYSQL_BACKUP_PASSWORD,MYSQL_RESTORE_PASSWORD,MYSQL_RESTORE_RUNTIME_PASSWORD,MYSQL_TEST_ADMIN_PASSWORD,MYSQL_TEST_READONLY_PASSWORD ./scripts/prepare-integration-db.sh

npm run test:integration
```

The preparation script refuses to reuse existing MySQL accounts or non-empty fixture schemas. It grants the application test identity DML only, gives DDL only to the separate migration identity, restricts the backup identity to SELECT/SHOW VIEW/TRIGGER, and grants the temporary restore identity SET_USER_ID only for the isolated restore fixture. The optional privilege-matrix test remains CI-only.

## Production deployment — existing release-managed host

The current Production host uses versioned release directories under /opt/ustore-releases/. Do not run install.sh, do not use the fixed-directory installer, and do not run npm run db:migrate with the runtime service account on that host.

The only supported Production procedure for this host is the approval-gated staged-release runbook:

- docs/PRODUCTION_STAGED_DEPLOYMENT.md
- docs/RELEASE_READINESS.md

That procedure requires an exact reviewed commit SHA, a protected backup and independent draw-key backup, a restored disposable copy, read-only preflight, a separate least-privilege migration identity, post-migration integrity checks, and explicit approval for the maintenance window. It does not authorize deployment by itself.

Never download a floating branch into the active release directory, never run two long-polling instances with the same bot token, and never apply SQL migration files manually. Production migrations must use the versioned migration runner and the protected migration-only credentials described in the runbook.

## Fresh-server installation

install.sh is not a deployment or upgrade mechanism for the existing release-managed Production host. It may be considered only for a genuinely new, isolated server after reviewing and pinning an exact installer commit. Do not execute a floating-branch curl | bash command, and do not point the installer at an existing Production database or release directory.
