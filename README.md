# UStore Telegram Bot

Telegram-native bot for private chats. This release does not use Telegram Business and does not include a web administration panel.

Requires Node.js 22+, MySQL 8+, and a Telegram bot token.

## Install manually

Copy `.env.example` to `.env`, configure credentials, and take a verified database backup before the first production migration. Then run:

```bash
npm ci
ALLOW_DATABASE_MIGRATIONS=1 ALLOW_PRODUCTION_MIGRATIONS=1 MIGRATION_TARGET_DATABASE=your_database_name npm run db:migrate
npm start
```

Replace `your_database_name` with the exact `MYSQL_DATABASE` value in `.env`. The migration guard intentionally refuses production schema changes unless both approval flags are present and the target name matches exactly. Do not run this command against production until the backup and target have been independently checked.

## Current product scope

- Persistent participant profile (name, Telegram-shared phone contact, Instagram handle).
- Inline Telegram menus and campaign operations.
- Free campaign entry with capacity enforcement, profile snapshots and unique entry codes. New campaign codes use `P{campaignId}-{six-character-middle}-{two-character-suffix}`; the middle segment's rightmost digits are a per-campaign sequence beginning at `1` and ending at `999999`.
- Paid-order, receipt-review and code-issuance services are present in this code line; do not enable paid campaigns in production until the end-to-end customer/admin flow has been verified against the target database and bot.
- Campaign draws use a committed random seed, an immutable candidate snapshot, deterministic HMAC-SHA256 ranking, encrypted seed storage before execution, and a revealed seed after completion. Draw actions require the dedicated `campaign.draw` permission (super-admin by default).
- Live payment-gateway integration remains deferred; bank-transfer receipt review is manual.
- Administration is inside Telegram. There is no web-panel password.

## Reliability controls

- Polling startup detects and removes a stale Telegram webhook without discarding pending updates.
- Telegram update IDs are claimed idempotently through a durable inbox; database-backed per-user rate limits are applied to text, callback and other updates.
- Inbox payloads contain the Telegram Update needed for replay. Completed payloads are retained for three days; pending, failed and stale-processing payloads are purged after thirty days. This retention window is an operational/privacy tradeoff and should be reviewed before production use.
- Correlation IDs are carried through async logs, processed-update rows, payment events, audit records and queued notifications.
- Notification delivery uses a leased outbox with bounded automatic retries. Failed and uncertain deliveries can be retried manually from the super-admin health screen; uncertain retries explicitly warn that duplicates are possible.
- Bank-card details are snapshotted per order, and successful presentation to a participant is recorded in the payment event history using only the card's last four digits.

See `docs/COMPLETION_SCOPE.md` for product invariants, `docs/VERIFIABLE_DRAWS.md` for the proof format and limitations, and `docs/RELEASE_READINESS.md` for the release gates and rollback procedure. The read-only production inventory is `scripts/production-migration-preflight.sql`.

## Tests

```bash
npm test

# Prepare an isolated disposable database (run as root for MySQL socket access)
sudo MYSQL_TEST_DATABASE=ustore_bot_ci ./scripts/prepare-integration-db.sh

# Run against that database, never against MYSQL_DATABASE from .env
MYSQL_TEST_DATABASE=ustore_bot_ci \
MYSQL_TEST_ADMIN_USER=root \
MYSQL_TEST_ADMIN_PASSWORD='<test-admin-password>' \
npm run test:integration
```

Integration tests require a disposable MySQL database whose name ends in `_ci` or `_test`. Never point integration tests at a production database.

## One-command Ubuntu installation

Supported on Ubuntu 22.04 and 24.04. The installer installs Git, Node.js 22 and MySQL, runs unit/static checks (MySQL integration tests are reserved for disposable `_ci`/`_test` databases), creates a dedicated database and MySQL user, applies versioned migrations, and installs the `ustore-telegram-bot` systemd service.

Run only after taking and verifying a production database backup. This installer changes the production schema and requires explicit approval flags:

```bash
curl -fsSL https://raw.githubusercontent.com/farjam2014/istore-lottery-bot/install/resumable-ubuntu-v2/install.sh | sudo env ALLOW_DATABASE_MIGRATIONS=1 ALLOW_PRODUCTION_MIGRATIONS=1 bash
```

The installer binds `MIGRATION_TARGET_DATABASE` to the validated `MYSQL_DATABASE` from `.env` (or the newly generated database name). If you supply `MIGRATION_TARGET_DATABASE` yourself, it must match exactly. The two approval flags authorize schema/database changes; do not set them until the backup and target have been checked.

### Safe resume behavior

- If `/opt/ustore-telegram-bot` does not exist, the installer creates it.
- If the directory already contains this repository, has the expected `origin`, is owned by `ustorebot`, and has no tracked local modifications, the installer updates the checkout to this installer branch. Untracked files are not deleted.
- If a valid `.env` already exists, it is preserved and its secrets are neither prompted for nor printed. If it does not exist, the installer asks for the bot token and numeric admin ID, then writes a mode-600 file.
- A fresh install generates a draw-seed encryption key in `.env`; back it up independently in an encrypted, access-controlled vault before the first draw. Existing installations without a valid legacy key or Keyring are stopped; the installer never invents a replacement key for existing draws.
- If the service is active, the installer stops it before changing the source checkout or applying schema migrations. If installation then fails, leave the service stopped until the code/schema state is inspected and recovered.
- The database and MySQL user are uniquely named and scoped to this application. The installer uses create-if-missing operations and never drops a database.
- An unrelated existing systemd unit or a checkout with tracked local edits causes a safe stop rather than an overwrite.

The installer does not make a database backup, and it cannot make a partially failed MySQL DDL migration transactional. Use it only after reviewing the code and keeping your own production backup. Do not rerun migrations manually against a database that reports a partially applied migration; inspect the migration state first.

## Deployment boundary

Pushing this branch changes GitHub only. It does not connect to or deploy on a VPS. The installer must be run explicitly on the target server.
