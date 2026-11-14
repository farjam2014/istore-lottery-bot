# iStore Lottery Bot

Clean Telegram-native implementation. Private chats only; no Telegram Business integration.

Requires Node.js 22+, MySQL 8+, and a Telegram bot token. Copy `.env.example` to `.env`, configure credentials, run `npm ci`, `npm run db:migrate`, then `npm start`.

Migrations are non-destructive. This repository commit does not deploy to a server or modify a live database.

Initial scope: persistent registration, server-side profile gating, inline user navigation, campaign discovery, profile/code views, basic admin statistics, MySQL schema and modular boundaries. Payment review, campaign administration, support queue and auditable draw execution remain subsequent implementation increments.
