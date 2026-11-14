# iStore Lottery Bot

Clean Telegram-native implementation. Private chats only; no Telegram Business integration.

Requires Node.js 22+, MySQL 8+, and a Telegram bot token. Copy `.env.example` to `.env`, configure credentials, run `npm install`, `npm run db:migrate`, then `npm start`.

## User flows
- Persistent one-time profile registration (name, normalized phone, Instagram handle).
- Inline user menu and paginated active campaign discovery.
- Free campaign entry with transaction, immutable profile snapshot, capacity enforcement and unique codes.
- Repeated entry requests return the original codes, not additional entries.

## Admin campaign creation
Open `/admin` → `مدیریت کمپین‌ها` → `افزودن کمپین`. The next screen presents inline `رایگان` and `پولی` buttons. The wizard collects title, description, capacity, codes per entrant, and price for paid campaigns, then stores the campaign as a draft. Admins can review and activate/pause drafts from the campaign list.

Paid order/receipt review and paid code issuance are not implemented yet. Do not activate paid campaigns until those flows are complete.

## Tests
- `npm test`: unit and (when enabled) integration tests.
- `npm run test:integration`: MySQL integration tests; use only a disposable database whose name ends in `_ci` or `_test`.

Migrations are non-destructive. This repository change does not deploy to a server or modify a live database.


## One-command Ubuntu installer

Supported on Ubuntu 22.04 and 24.04. Run this on a fresh server as a sudo-capable user; it prompts for the Telegram bot token and numeric admin ID, installs Node.js 22 and MySQL, creates a separate database with a random password, applies the schema, and registers a systemd service.

```bash
curl -fsSL https://raw.githubusercontent.com/farjam2014/istore-lottery-bot/install/one-command-ubuntu/install.sh | sudo bash
```

The installer refuses to overwrite /opt/ustore-telegram-bot and creates a uniquely named database; it does not drop existing databases. Credentials are written to /opt/ustore-telegram-bot/.env with mode 600. This release has Telegram-based administration, not a web panel. Review the installer before running it on a production host.
