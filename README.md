# UStore Telegram Bot

Telegram-native bot for private chats. This release does not use Telegram Business and does not include a web administration panel.

Requires Node.js 22+, MySQL 8+, and a Telegram bot token.

## Install manually

Copy `.env.example` to `.env`, configure credentials, then run:

```bash
npm install
npm run db:migrate
npm start
```

## Current product scope

- Persistent participant profile (name, Telegram-shared phone contact, Instagram handle).
- Inline Telegram menus and campaign operations.
- Free campaign entry with capacity enforcement, profile snapshots and unique entry codes.
- Paid-order, receipt-review and code-issuance services are present in this code line; do not enable paid campaigns in production until the end-to-end customer/admin flow has been verified against the target database and bot.
- Campaign draw execution and winner selection remain deferred.
- Live payment-gateway integration remains deferred; bank-transfer receipt review is manual.
- Administration is inside Telegram. There is no web-panel password.

## Reliability controls\n\n- Polling startup detects and removes a stale Telegram webhook without discarding pending updates.\n- Telegram update IDs are claimed idempotently; database-backed per-user rate limits are applied to text, callback and other updates.\n- Correlation IDs are carried through async logs, processed-update rows, payment events, audit records and queued notifications.\n- Notification delivery uses a leased outbox with bounded automatic retries. Definitive Telegram 429 responses are retried using `retry_after`; permanent 4xx rejections move to failed; network errors, timeouts and 5xx responses move to uncertain and are never automatically resent because Telegram may already have accepted the message. Failed and uncertain deliveries require explicit, bounded super-admin retry confirmation with duplicate-delivery warnings.\n- Bank-card details are snapshotted per order, and successful presentation to a participant is recorded in the payment event history using only the card's last four digits.\n\nSee `docs/COMPLETION_SCOPE.md` for product invariants and acceptance requirements.

## Tests

```bash
npm test
npm run test:integration
```

Integration tests require a disposable MySQL database whose name ends in `_ci` or `_test`. Never point integration tests at a production database.

## One-command Ubuntu installation

Supported on Ubuntu 22.04 and 24.04. The installer installs Git, Node.js 22 and MySQL, runs the automated tests, creates a dedicated database and MySQL user, applies versioned migrations, and installs the `ustore-telegram-bot` systemd service.

Run as root on the VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/farjam2014/istore-lottery-bot/install/resumable-ubuntu-v2/install.sh | sudo bash
```

### Safe resume behavior

- If `/opt/ustore-telegram-bot` does not exist, the installer creates it.
- If the directory already contains this repository, has the expected `origin`, is owned by `ustorebot`, and has no tracked local modifications, the installer updates the checkout to this installer branch. Untracked files are not deleted.
- If a valid `.env` already exists, it is preserved and its secrets are neither prompted for nor printed. If it does not exist, the installer asks for the bot token and numeric admin ID, then writes a mode-600 file.
- The database and MySQL user are uniquely named and scoped to this application. The installer uses create-if-missing operations and never drops a database.
- An unrelated existing systemd unit or a checkout with tracked local edits causes a safe stop rather than an overwrite.

The installer does not make a database backup, and it cannot make a partially failed MySQL DDL migration transactional. Use it only after reviewing the code and keeping your own production backup. Do not rerun migrations manually against a database that reports a partially applied migration; inspect the migration state first.

## Deployment boundary

Pushing this branch changes GitHub only. It does not connect to or deploy on a VPS. The installer must be run explicitly on the target server.
