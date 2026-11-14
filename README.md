# iStore Lottery Bot

Clean Telegram-native implementation. Private chats only; no Telegram Business integration.

Requires Node.js 22+, MySQL 8+, and a Telegram bot token. Copy `.env.example` to `.env`, configure credentials, run `npm install`, `npm run db:migrate`, then `npm start`.

Migrations are non-destructive. This repository commit does not deploy to a server or modify a live database.

Initial implementation includes persistent registration, server-side profile gating, inline user navigation, campaign discovery, transactional free campaign entry and code issuance, profile/code views, basic admin statistics, MySQL schema and modular boundaries. Paid payment review, full campaign administration, support queue, audited draw execution, and production deployment remain unfinished.
