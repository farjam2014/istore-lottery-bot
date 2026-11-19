# Fresh Server Acceptance Checklist

This checklist is for deploying the audited repository to a brand-new, disposable Ubuntu server. It is not a migration procedure for the current server or database.

## Preconditions

- [ ] New Ubuntu 24.04 LTS server.
- [ ] No production database or production bot data on this server.
- [ ] Repository commit/PR has passed CI.
- [ ] Installer source and checksum have been reviewed.
- [ ] Telegram bot token and administrator Telegram ID are available.
- [ ] Domain/DNS and TLS are not required for Telegram long polling.
- [ ] A separate, tested backup of the repository baseline exists.

## Install

- [ ] Run the installer with explicit database-migration authorization flags.
- [ ] Confirm the installer creates/preserves a protected `.env`.
- [ ] Confirm the generated MySQL database name is disposable and unique.
- [ ] Confirm the application user has privileges only on its application database.
- [ ] Confirm the installer runs `npm ci --omit=dev`.
- [ ] Confirm tests pass before migration.
- [ ] Confirm all migrations complete and the migration history/checksums are recorded.
- [ ] Confirm systemd unit is installed and enabled.
- [ ] Confirm the service reaches `ActiveState=active`, `SubState=running`, and a nonzero `MainPID`.
- [ ] Confirm the fresh journal contains `Telegram bot launched with long polling`.
- [ ] Confirm the installer does not print bot token, DB password, or draw encryption key.

## Functional smoke test

- [ ] Bot responds to `/start` in private chat.
- [ ] Configured super-admin can open `/admin`.
- [ ] Non-admin cannot access admin actions.
- [ ] Registration validates phone and Instagram handle.
- [ ] A free campaign can be created, activated, joined, and issue a code.
- [ ] Campaign field-edit wizard works for title, dates, capacity, price, and other editable fields.
- [ ] Paid campaign creates a quantity-aware order and snapshots the payment card.
- [ ] Receipt submission and admin approval issue exactly the purchased quantity.
- [ ] Repeat orders respect cumulative per-person limits.
- [ ] Draw preparation blocks active repeat payment orders.
- [ ] Draw preparation respects configured `draw_at`.
- [ ] Campaign can be manually closed when it has no end date.
- [ ] Campaign cannot be archived while eligible entries remain.
- [ ] Draw commitment can be published and the draw completed.
- [ ] Draw proof exports and offline verifier returns a valid result.
- [ ] Support ticket creation/replies and admin notifications work.
- [ ] Notification outbox retries and terminal failures are visible.
- [ ] CSV exports are safely escaped.

## Operational checks

- [ ] `systemctl status ustore-telegram-bot.service` is healthy.
- [ ] Journal contains no repeated restart loop.
- [ ] MySQL is local and not exposed publicly.
- [ ] `.env` permissions are `600`.
- [ ] App files are owned by the dedicated app user.
- [ ] No secrets are tracked in Git.
- [ ] Draw encryption key is backed up securely and separately.
- [ ] Database backup/restore has been tested on a disposable database.
- [ ] Recovery steps are documented before production use.

## Acceptance decision

Do not move the bot to production until all P0/P1 findings are closed, CI is green on the exact release commit, this checklist is completed, and the backup/restore procedure has been tested.
