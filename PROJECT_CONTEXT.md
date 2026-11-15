# UStore Telegram Bot — Project Context

> Canonical handoff document for future development conversations. Read this file first, then `PROJECT_ROADMAP.md`, `DEPLOYMENT.md`, and the linked source documentation. Re-verify live GitHub/VPS state before acting; this file is a snapshot, not live telemetry.

## Repository and runtime

- Repository: [farjam2014/istore-lottery-bot](https://github.com/farjam2014/istore-lottery-bot)
- Production branch: `install/resumable-ubuntu-v2`
- VPS checkout: `/opt/ustore-telegram-bot`
- Runtime: Node.js 22+, MySQL 8+, Telegraf, ES modules
- systemd unit: `ustore-telegram-bot.service`
- Entry point: `src/index.js`
- Telegram interface: private-chat Telegram bot; this release does not use Telegram Business and does not include a web administration panel.
- Configuration is validated in `src/config/env.js`; secrets belong in server-side environment configuration only, never in Git or documentation.

## Start here when continuing work

1. Read this file, `PROJECT_ROADMAP.md`, and `DEPLOYMENT.md`.
2. Inspect the current production branch head and recent PRs/commits. Do not assume the recorded SHA is still current.
3. Inspect relevant implementation, migrations, tests, and current CI results before making claims.
4. For VPS work, ask the operator to run read-only commands first. The assistant has no implicit SSH access.
5. Update the roadmap and relevant docs as work is completed. Record evidence (commit/PR, test command and result, deployment confirmation).

## Product and architecture

The bot is a Telegram-native application. The intended architecture boundaries are:

- `src/bot/`: Telegram transport, handlers, keyboards, registration and middleware.
- `src/modules/`: domain use-cases and business services.
- `src/database/`: MySQL pool, base schema, versioned SQL migrations.
- `src/shared/`: shared infrastructure helpers, including date/time and logging.
- `src/config/`: environment validation.

Architectural rules documented in `docs/ARCHITECTURE.md`:
- Handlers should not contain SQL.
- Repositories should not depend on Telegram.
- Services own business rules and transactions.
- Participant profile is unique by Telegram user ID.
- Registration is enforced server-side; campaign-entry profile snapshots preserve the data at entry time.

Main implemented domains visible in the current source tree:
- campaigns and campaign scheduling
- participant profiles and entries
- payments, receipt review, bank-card settings
- admin access, roles and permissions
- notification outbox and Telegram delivery
- management reports and CSV export
- support-related schema and flows (verify current behavior before asserting completeness)

## Approved product rules and explicit deferrals

The detailed acceptance plan is `docs/COMPLETION_SCOPE.md`. Preserve these known decisions unless the owner explicitly changes them:

- One code represents one independent ticket.
- A participant may win at most one prize per campaign.
- Draw execution and winner selection are deferred; do not expose or imply a live draw capability until implemented, tested and explicitly approved.
- Manual bank-transfer receipt review is supported in the current product direction.
- A provider-neutral online-payment abstraction may exist, but live payment-gateway integration is deferred until a provider is selected and verified.
- Paid campaigns must not be enabled in production until the complete customer/admin payment flow is verified against the target database and bot.
- Capacity reservation/release must be atomic and concurrency-safe.
- Support messages and ticket history must be persisted centrally.
- Admin permissions are shared across explicitly allowlisted accounts; see `docs/ADMIN_ROLES.md`.
- Normal navigation/actions should use inline Telegram buttons, not require users to type commands.
- The web panel is outside the current date/time integration scope and is not part of this release's product surface.

## Date/time contract

The Telegram bot date/time integration merged in PR #13:
- Shared implementation: `src/shared/datetime.js`.
- Display timezone: `Asia/Tehran`.
- User/admin-facing calendar: Persian/Jalali, with 24-hour Tehran time.
- Campaign schedule input is Jalali local Tehran time and is converted to UTC before persistence.
- Database timestamps, scheduling and expiry calculations remain UTC.
- Historical database timestamps were not rewritten; no schema migration was added for the Jalali integration.
- The web panel was explicitly out of scope.

Do not introduce local-server-time assumptions. Parse MySQL `DATETIME` values as UTC and format for Tehran only at the presentation boundary. Add tests for date boundaries, leap days, invalid dates, timezone conversion and UTC comparisons when changing this code.

## Recent verified history (snapshot from 2026-11-15)

- PR #11: payment receipt photo notifications and delivery support.
- PR #12: corrected literal newline handling in Persian Telegram messages.
- PR #13: unified Jalali dates and Tehran time in the Telegram bot.
- Production branch head after PR #13 merge: `ee2a85cfd886145547310ec845fff68036fd4ea2`.
- PR #13 merge: [#13](https://github.com/farjam2014/istore-lottery-bot/pull/13).
- GitHub Actions run recorded for PR #13: [43754409445](https://github.com/farjam2014/istore-lottery-bot/actions/runs/43754409445), 56 tests passed, 0 failed; MySQL integration tests ran in CI.
- On the VPS after deployment, `node --test tests/datetime.test.js` passed 4/4.
- On the VPS, ordinary `npm test` reported 38 passed, 0 failed, 18 skipped. The skipped tests were MySQL integration tests because the integration flag was not enabled. Do not describe these 18 as passed on the VPS.
- The VPS service was restarted after updating to `ee2a85c`; the operator supplied output showing `active/running`, new PID `172804`, successful database connection and Telegram long polling startup. This was an operator-provided observation at that time, not a live status guarantee.

## Safety and change-management rules

- Never expose or request bot tokens, database passwords, private keys, full payment-card data or raw receipt identifiers.
- Never run integration tests against production. Use a disposable MySQL database with a name ending in `_ci` or `_test`, as documented in the README and test preparation script.
- Never run destructive installer/reset flows, drop tables/databases, rewrite production data or perform irreversible migrations without explicit owner approval.
- Inspect migration history/checksums before retrying a failed migration; MySQL DDL is not generally transactional.
- Prefer additive, versioned migrations and forward fixes.
- Do not deploy/restart the production service without explicit approval for that deployment.
- Do not claim a change is complete until implementation, tests, review, merge and deployment (where applicable) are separately evidenced.

## Documentation map

- `PROJECT_CONTEXT.md`: product, architecture, invariants and handoff.
- `PROJECT_ROADMAP.md`: status ledger, outstanding verification and deferred scope.
- `DEPLOYMENT.md`: VPS layout, safe commands and deployment verification.
- `docs/ARCHITECTURE.md`: architecture boundaries.
- `docs/COMPLETION_SCOPE.md`: acceptance requirements and product invariants.
- `docs/ADMIN_ROLES.md`: admin authorization model.
- `docs/PAYMENT_OPERATIONS.md`: payment operations notes.
- `docs/CLEAN_REBUILD_CONTRACT.md`: installer/rebuild safety contract.
