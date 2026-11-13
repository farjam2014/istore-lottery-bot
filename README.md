# USTORE Campaign & Lottery Bot

Telegram-first, multi-campaign platform for USTORE. The current implementation uses one normalized MySQL schema for participants, campaign memberships, codes, orders, payments, draw evidence, support tickets, account recovery, Telegram sessions and operational queues.

## Fresh-install policy

This repository is being prepared as a new installation. The legacy single-campaign data model is not used:

- No runtime dependency on `lottery_entries`, `lottery_settings`, `lottery_draws` or legacy session tables.
- `participants` is the customer profile; `campaign_entries` is membership in a specific campaign; `campaign_codes` holds issued codes.
- Campaign orders, receipts, reservations and draws are scoped to a campaign.
- `schema.sql` is intentionally not an importable legacy schema. Use the migration runner.

The installer is non-destructive. It creates the database when missing and proceeds only if the target database has zero tables. It never drops a database or table. If the database already contains tables, installation stops for manual review.

## Install — Ubuntu 24.04

The installer currently targets the development branch used for this initial build:

```bash
curl -fsSL https://raw.githubusercontent.com/farjam2014/istore-lottery-bot/feature/telegram-account-recovery/install.sh -o /root/istore-install.sh
sudo bash /root/istore-install.sh
```

It validates the domain and Telegram bot token, runs the test suite in a staging directory before replacing the application, creates a fresh empty database, generates credentials and secrets, runs migrations, configures systemd/Nginx/HTTPS and registers the webhook.

The installer moves an existing application directory to a timestamped folder; it does not delete it. It does not back up or modify a non-empty database. Keep the generated `/opt/istore-lottery-bot/.env` private.

## Configuration

The installer asks for:

- Domain and SSL email
- Telegram BotFather token
- Numeric Telegram admin ID
- Optional `CONTACT_PHONE`
- Optional store Telegram URL

The generated `.env` contains `BOT_TOKEN`, `WEBHOOK_SECRET`, `SESSION_SECRET`, database credentials, `ADMIN_ID`, `CONTACT_PHONE`, and `PUBLIC_SITE_URL`.

If `CONTACT_PHONE` is blank, the optional contact gate is disabled. If configured, the gate records an explicit user confirmation; Telegram Bot API cannot verify whether a user actually saved the contact or can view a Telegram story.

## Data model

- `participants`: one persistent customer profile linked to Telegram
- `campaigns`: campaign configuration and lifecycle
- `campaign_entries`: participant membership per campaign
- `campaign_codes`: unique campaign codes
- `payment_orders`, `payment_receipts`, `payment_transactions`, `campaign_capacity_reservations`: payment and capacity lifecycle
- `campaign_draws`, `draw_candidates`, `draw_winners`, `draw_evidence`: draw preparation and evidence
- `telegram_sessions`, `telegram_notification_outbox`, `webhook_inbox`, `processed_updates`: conversation state and durable processing
- `customer_support_tickets`, `web_accounts`, `password_reset_requests`, `account_reset_tokens`: support and account recovery

Run migrations with:

```bash
npm run migrate
```

Migrations are idempotent and create the normalized schema. They do not import or migrate records from the retired single-campaign database.

## Admin operations

Send `/panel` to the bot from the configured admin account. The Telegram panel supports:

- Campaign lifecycle and payment-card configuration
- Customer profile lookup and activation/deactivation
- Orders, receipts and profile-change requests
- Per-campaign reports and CSV export
- Campaign draw preparation, result review and approval
- Audit history

For support replies, use `/reply TICKET_ID message` in the admin's private chat.

## Operational checks

```bash
sudo systemctl status istore-lottery-bot
sudo journalctl -u istore-lottery-bot -f
curl -fsS https://YOUR_DOMAIN/health
```

Before opening registration, require a green GitHub Actions run, a successful fresh-database migration test, Telegram private-chat and Telegram Business acceptance tests, payment receipt review tests, and a staging draw review.

## Current limitations

- Telegram cannot technically verify Instagram follows or contact saving.
- Manual card-to-card payment and manual receipt approval are supported; an online payment gateway is not implemented.
- Live-wheel/hybrid draw evidence and the independent public verification flow still require additional acceptance work.
- This branch is still under development. A successful GitHub CI run and staging acceptance are required before deployment.
