# iStore Telegram Bot — Clean Rebuild

This branch is the only implementation target for the new Telegram-native bot.

## Non-negotiable product contract

- Telegram Bot API private chats only. No Telegram Business connection, business update, business session, or business-specific payload.
- A fresh user receives a welcome/introduction message and exactly one inline button: **ثبت‌نام**.
- Until a profile is created, every user command and callback except registration continuation/cancellation is denied server-side.
- Registration creates one global profile keyed by Telegram user ID. It is not tied to a campaign.
- A completed profile unlocks the user menu: کمپین‌ها، کدهای من، سفارش‌ها، حساب کاربری، پشتیبانی.
- Joining a campaign creates a separate campaign entry referencing the existing profile. Profile data is copied into an immutable campaign snapshot; campaign codes belong to that campaign entry only.
- One profile can join multiple campaigns. A campaign can have at most one entry per profile unless the campaign policy explicitly changes.
- Free campaign participation issues codes transactionally. Paid participation reserves capacity, creates an order, accepts a receipt, and issues codes only after an administrator approves payment.
- Registration remains available even when no campaign is open. The campaign list then explains that no active campaign is available.
- Profile edits are requests reviewed by an administrator; historical campaign snapshots and issued codes are not silently rewritten.

## Clean database policy

The clean-install path is intentionally destructive and must require an exact interactive confirmation before touching the target database. It drops every table in the configured target database and recreates only the new schema. It must never connect to, inspect, or delete another database. No legacy data import, compatibility views, legacy campaign, legacy table, or old code path is permitted.

## Release gates

1. No references to legacy table names or Telegram Business fields in runtime code, migrations, admin bot, tests, or installer (except a one-time negative assertion that verifies their absence).
2. MySQL integration tests run against a disposable database and cover clean install, unique profile, multi-campaign entry, idempotent code issuance, payment approval, and draw snapshot integrity.
3. Unit and static checks pass.
4. No production deployment until the user explicitly requests it after reviewing the tested build.

## Data model

- `participants`: one profile per Telegram user.
- `telegram_user_sessions`: registration wizard only.
- `campaigns`: independent campaign configuration and lifecycle.
- `campaign_entries`: a profile's participation in a campaign plus immutable profile snapshot.
- `campaign_codes`: codes issued to one campaign entry.
- `payment_orders`, `payment_receipts`, `payment_transactions`: paid campaign workflow.
- `profile_change_requests`: reviewed profile edits.
- `campaign_draws`, `draw_candidates`, `draw_winners`, `draw_evidence`: auditable draw workflow.
- `admin_audit_log`, `webhook_inbox`, `processed_updates`, `telegram_notification_outbox`: reliability and audit infrastructure.
