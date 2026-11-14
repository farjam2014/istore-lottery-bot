# iStore Telegram Bot — Clean Rebuild

## Product rules
- Telegram Bot API private chats only; no Telegram Business integration.
- A new user sees a welcome message and one inline button: ثبت‌نام.
- All actions are denied server-side until a global profile exists, except registration continuation and cancellation.
- One profile per Telegram user ID, independent of campaigns.
- User menu: campaigns, my codes, orders, account, support.
- Campaign entry is separate from profile and stores an immutable profile snapshot.
- One profile can enter multiple campaigns; one entry per profile per campaign.
- Free entries issue codes transactionally. Paid entries issue codes only after administrator payment approval.
- Profile changes are requests; historical campaign snapshots are not rewritten.

## Clean database policy
Normal migrations are non-destructive. Any destructive clean install must require exact confirmation, be restricted to the configured target database, and never inspect or modify another database. Production deployment requires explicit user approval.

## Release gates
- No old runtime paths or Telegram Business payloads.
- MySQL integration tests for clean schema, unique profiles, multiple campaigns, idempotent code issuance, payment approval and draw snapshot integrity.
- Unit tests, syntax checks and install smoke tests pass.
- No production deployment before explicit approval.

## Domain tables
participants, telegram_user_sessions, campaigns, campaign_entries, campaign_codes, payment_orders, payment_receipts, profile_change_requests, campaign_draws, draw_candidates, draw_winners, admin_audit_log, processed_updates, telegram_notification_outbox.
