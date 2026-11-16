# UStore Telegram Bot — Canonical Project Context

> Canonical handoff for every future development session. Read this file, then `PROJECT_ROADMAP.md` and `DEPLOYMENT.md`, before proposing or changing anything. These documents are maintained snapshots, not live telemetry. Re-check the operational branch, PRs, CI, source, VPS and service state before acting.

## 1. Project identity and current operating model

- Repository: https://github.com/farjam2014/istore-lottery-bot
- Operational branch: `install/resumable-ubuntu-v2`
- VPS checkout: `/opt/ustore-telegram-bot`
- Runtime: Node.js 22.x, MySQL 8.x, Telegraf, ES modules
- Entry point: `src/index.js`
- systemd unit: `ustore-telegram-bot.service`
- Service account: `ustorebot`
- Interface in the current release: Telegram Bot API private chats with inline keyboards.
- This release does not use Telegram Business and has no web administration panel.
- Assistant has no implicit SSH access. The operator executes server commands and shares sanitized output.
- GitHub changes do not deploy to the VPS. Deployment is a separate, explicitly approved operation.

## 2. Product purpose and approved scope

The application is a campaign-based UStore customer and campaign operations bot. It is designed to manage persistent customer profiles, campaign participation, entry codes, paid orders and manual receipt review, support, admin workflows, reporting and operational reliability.

The current release scope is defined by `docs/COMPLETION_SCOPE.md`. Its key invariants are:

- A participant has one global profile keyed by Telegram user ID.
- A campaign entry is separate from the profile and preserves an immutable profile snapshot.
- One profile may enter multiple campaigns, but only once per campaign.
- One code represents one independent ticket.
- Paid entry codes are issued only after an administrator approves payment.
- A participant may win at most one prize per campaign; actual draw execution and winner selection are deferred.
- Capacity reservation and release must be atomic and concurrency-safe.
- Payment evidence is reviewed manually; live gateway provider selection/integration is deferred.
- Support ticket messages are persisted centrally.
- Admin permissions are shared across explicitly allowlisted accounts; current role design is documented in `docs/ADMIN_ROLES.md`.
- Normal user/admin navigation uses inline Telegram buttons. Text input is for actual free-form data only.
- Web administration is deferred/out of current release scope.
- Do not enable paid campaigns in production until the full customer/admin payment lifecycle has been verified on an isolated target-like environment and through Telegram end-to-end tests.

## 3. Technical architecture and boundaries

Relevant source areas (verify current tree before editing):
- `src/bot/`: Telegram transport, handlers, keyboards, middleware and update processing.
- `src/modules/`: domain services/use-cases and repositories.
- `src/database/`: MySQL pool, base schema and versioned migrations.
- `src/shared/`: shared infrastructure such as date/time and logging.
- `src/config/`: environment parsing and validation.

Architecture rules in `docs/ARCHITECTURE.md`:
- Handlers do not contain SQL.
- Repositories do not depend on Telegram.
- Services own business rules and transaction boundaries.
- Enforce registration and authorization server-side; hiding a button is not authorization.
- Validate ownership on every customer resource lookup.
- Use unique constraints, transactions and idempotency for concurrency-sensitive operations.
- Keep external Telegram delivery outside database transactions; use the notification outbox.
- Keep sensitive values out of logs, Git and documentation.

Main domains represented in the source tree include:
- registration and participant profiles
- campaign configuration, lifecycle and scheduling
- free entries, paid orders, capacity reservations and code issuance
- bank-card configuration snapshots and receipt review
- admin identities, roles, permissions and audit events
- processed Telegram updates, rate limiting and correlation context
- notification outbox, delivery history and retry/recovery
- support tickets/messages
- management reports and CSV export

The presence of a module/table is not proof that its complete product acceptance criteria pass. Use the roadmap and acceptance plan.

## 4. Customer and admin interaction contract

### Customer
- First-time users receive a welcome/registration entry point.
- Required profile fields: full name, Telegram-shared mobile contact, Instagram handle.
- Mobile ownership is validated using Telegram's native contact request; accept only a contact whose `user_id` matches the sender. Do not trust a typed number or forwarded/other contact as ownership proof.
- User menu covers campaigns, codes, orders, account/profile and support.
- Profile edits are requests; approved current-profile changes must not rewrite historical campaign-entry snapshots.
- Free and paid participation paths are distinct; paid codes are not issued before payment approval.

### Admin
- Admin access is configured through trusted numeric Telegram IDs in `BOT_ADMIN_IDS`; additional staff are assigned roles from the Telegram inline admin interface.
- Super-admin, campaign manager, finance manager and support agent permissions are documented in `docs/ADMIN_ROLES.md`.
- Every callback, command, photo and text action must enforce permissions server-side.
- Admin actions affecting money, status, participant access or staff permissions require audit history and idempotent behavior.
- Payment operations are described in `docs/PAYMENT_OPERATIONS.md`.

## 5. Payment, capacity and notification invariants

- Manual bank transfer and receipt photo submission/review are the current payment direction.
- Store immutable order amount, campaign and bank-destination snapshot.
- Approve/reject operations must be transactional and idempotent.
- Codes issue only after successful approval.
- A rejected order may resubmit a receipt while valid; pending receipt actions and expiry paths must be explicit.
- Reservation expiry must release capacity and notify the customer through a scheduled worker, not only when the customer returns.
- Capacity allocation/release must remain safe under concurrent requests.
- Notification outbox uses bounded retries and leases. Delivery is retryable/at-least-once, not a guarantee of exactly-once Telegram delivery. An uncertain manual retry can create a duplicate and must warn the operator.
- Record notification attempts/delivery state and correlate related events. Never expose raw Telegram file tokens or unnecessary receipt identifiers.

## 6. Date and time contract

PR #13 introduced the shared date/time behavior:
- Shared utility: `src/shared/datetime.js`.
- Database timestamps and scheduling/expiry logic remain UTC.
- Parse MySQL `DATETIME` explicitly as UTC.
- Present user/admin-facing dates in the Persian/Jalali calendar and 24-hour Tehran time (`Asia/Tehran`).
- Campaign schedule input is Tehran-local Jalali date/time converted to UTC before persistence.
- No historical database timestamp rewrite or date/time schema migration was part of PR #13.
- Web-panel date/time behavior is outside current scope.
- Add boundary, leap-day, invalid-date and timezone conversion tests when changing date/time logic.

## 7. Project history and decisions (chronological, evidence-based)

This is a handoff summary, not a claim that every experiment or abandoned branch is part of the current release.

1. **Initial build and scope reset (November 2026):** the project moved away from the retired single-campaign/legacy-table approach toward a clean Telegram-native, multi-campaign model with normalized participant profiles, campaign entries, codes, orders, receipts, support and operational tables. The current release does not revive the legacy schema or old runtime paths. Do not copy legacy migrations/data assumptions into the current design without an explicit migration plan.
2. **Architecture and product acceptance:** architecture boundaries and business invariants were consolidated in `docs/ARCHITECTURE.md` and `docs/COMPLETION_SCOPE.md`. The completion scope is the authoritative acceptance reference; this context file is the handoff summary.
3. **PR #11:** payment receipt photo notification/delivery support and associated outbox photo/caption handling were added. Operator-reported VPS test snapshot: 52 tests, 34 passed, 0 failed, 18 skipped (MySQL integration skipped); service was reported active after deployment. Treat this as historical operator evidence, not current live status.
4. **PR #12:** corrected Persian message line-break handling where literal backslash-n appeared instead of actual line breaks. Merged commit recorded as `69b12dc6a2d5d40969d37d6eb109eb4e71e2f15e`.
5. **PR #13:** unified Jalali calendar and Tehran display time in Telegram flows, with UTC storage and scheduling preserved. Merge SHA recorded as `ee2a85cfd886145547310ec845fff68036fd4ea2`. CI run `43754409445` reported 56/56 tests passing, including isolated MySQL integration tests. VPS run reported 4/4 date-time tests and `npm test` 38 passed, 0 failed, 18 skipped; those 18 integration tests were not run on the VPS. Operator later supplied service output showing active/running, successful DB connection and Telegram long-polling startup. Manual Telegram/Jalali end-to-end smoke checks remained pending in the recorded roadmap.
6. **PR #14:** documentation-only handoff files were added and merged on 2026-11-15. Merge commit recorded as `65cae7585fcb8bde5f4d837fa173715e6717c12f`. It did not change application code, database, VPS or service.
7. **Reliability and operations work recorded in current repository documentation/README:** stale-webhook recovery at polling startup, idempotent Telegram update claims, database-backed per-user rate limiting, correlation IDs across processing/logging/payment/audit/notifications, leased outbox with bounded retries, manual retry visibility/warnings, and bank-card presentation history limited to last four digits. Re-verify implementation and CI on the exact current head before marking individual acceptance items complete.
8. **PR #16 — campaign-specific sequential raffle codes:** merged into `install/resumable-ubuntu-v2` on 2026-11-16. Squash merge `193602976e1d29c4de5e9d3b1ac4b96a13eee7c3`. CI run `43871251991` passed 64/64 tests, 0 failed, 0 skipped, plus syntax checks. New codes use `P{campaign_id}-{six-character-middle}-{two-character-suffix}`, per-campaign sequence starting at 10001. The migration clears only the explicitly approved test participation/payment/draw records; campaign definitions and participant master profiles remain. **The migration has not been applied to the VPS or production database.**
9. **PR #17 — active admin registration-session bypass:** merged into the operational branch on 2026-11-16. Merge commit `b269c280c1beade14c2ef1d7d56321bc59edbb34`. Latest-head CI run `43872103482` passed 70/70 tests, 0 failures, 0 skips, and both JavaScript syntax checks. Active staff with `dashboard.read` now pass through stale customer registration sessions; permission lookup failures fail closed. No DB schema change.
10. **PR #18 — project handoff refresh:** documentation-only merge `14c09717bef200aca05193a5416a98bc0107493c`; CI run `43872431924` passed. No application code, schema, VPS or service change.
11. **PR #20 — uncertain notification retry confirmation:** open Draft based on the current operational branch. The super-admin action now displays the uncertain-delivery/duplicate warning and requires a second confirmation callback before re-queuing; source-contract tests added. Latest-head CI is pending.

Important historical caution:
- Earlier project conversations/branches explored Laravel/PHP, web panels, Telegram Business, Instagram integration, different database layouts and lottery/draw execution. Those are not automatically current product commitments. Current operational release is Node.js/Telegraf, Telegram Bot API private chats, MySQL, no web panel, no Telegram Business, and draw execution deferred.
- Older PRs/branches can be drafts or superseded experiments. Do not merge, deploy or revive them just because they exist.

## 8. Current baseline and verification caveats

- GitHub operational branch `install/resumable-ubuntu-v2` includes PR #16 (`193602976e1d29c4de5e9d3b1ac4b96a13eee7c3`), PR #17 (`b269c280c1beade14c2ef1d7d56321bc59edbb34`) and docs-only PR #18 (`14c09717bef200aca05193a5416a98bc0107493c`). CI runs #372 (64 tests), #381 (70 tests) and #386 (success on docs refresh) completed successfully; all recorded tests had zero failures/skips and syntax checks passed.
- PR #7 remains an open Draft from `install/resumable-ubuntu-v2` into `rebuild/telegram-native-v1`; it has not been merged into its base. Its latest head is `14c09717bef200aca05193a5416a98bc0107493c`. PRs #2–#6 are older stacked Draft experiments and are not the current operational baseline.
- PR #17 is merged; active-staff registration-session bypass is source- and CI-verified, but not deployed to the VPS.
- PR #20 is an open Draft for uncertain-notification retry confirmation; CI pending at this snapshot.
- Last explicitly recorded deployed application-code commit remains `ee2a85cfd886145547310ec845fff68036fd4ea2` from the earlier operator snapshot. There is no evidence that PR #16 has been deployed or its migration applied. Confirm the actual VPS HEAD and service before runtime claims.
- The 2026-11-15 test/deploy observations are historical snapshots. Never present them as live service status.
- Current feature-level acceptance gaps are tracked in `PROJECT_ROADMAP.md`; authoritative product criteria remain in `docs/COMPLETION_SCOPE.md`.

## 9. Mandatory workflow for every future change

1. Read all three root handoff documents and the relevant detailed docs.
2. Re-check operational branch head, open/merged PRs, CI status and actual source. For VPS tasks, request read-only preflight output first.
3. State the exact requirement, non-goals, affected flows/data, risk and acceptance tests before editing.
4. Inspect handlers, services, repositories, schema/migrations, authorization and failure/retry paths end-to-end.
5. Implement the smallest coherent change on a feature branch; do not work directly on the production branch for risky changes.
6. Add focused unit/integration/regression tests. Integration tests must use a disposable MySQL database with a name ending `_ci` or `_test`, never production.
7. Run syntax checks and relevant tests; report pass/fail/skipped separately. Inspect the complete diff for unrelated changes and secrets.
8. Open a PR with scope, risks, test evidence and deployment status. Merge only after review/CI and applicable approval.
9. Deployment is a separate step requiring explicit owner approval. GitHub merge is not deployment.
10. After deployment, verify service/process/log/DB connectivity and perform a safe Telegram smoke test. Do not claim runtime success from CI alone.
11. Update the relevant root docs in the same work item/PR: context for architecture/product decisions, roadmap for feature status and evidence, deployment for server/runbook changes.
12. Record unresolved issues and next actions. Never erase failed-test history or mark unverified behavior complete.

## 10. Safety rules — non-negotiable

- Never request, print, commit or document bot tokens, DB passwords, private keys, full card numbers, raw receipt file IDs or sensitive customer data.
- Never run destructive installer/reset flows, drop databases/tables, rewrite production data, force-reset a checkout, or perform irreversible migrations without explicit owner approval and a verified recovery plan.
- Never run integration tests against production.
- MySQL DDL may not be transactional. Inspect migration history/checksums and partial state before retrying a failed migration.
- Prefer additive versioned migrations and forward fixes.
- Do not restart/deploy the production service without explicit approval.
- Do not claim a change is complete until code, tests, CI, merge, deployment and runtime verification are separately evidenced where applicable.

## 11. Documentation map

- `PROJECT_CONTEXT.md`: product, architecture, decisions, invariants and development workflow.
- `PROJECT_ROADMAP.md`: status ledger, audit backlog, evidence and deferred scope.
- `DEPLOYMENT.md`: VPS facts, safe preflight, test policy, deployment and recovery.
- `docs/COMPLETION_SCOPE.md`: authoritative acceptance plan.
- `docs/ARCHITECTURE.md`: code boundaries and architecture rules.
- `docs/ADMIN_ROLES.md`: admin roles and authorization.
- `docs/PAYMENT_OPERATIONS.md`: payment operations.
- `docs/CLEAN_REBUILD_CONTRACT.md`: rebuild and installer safety contract.
- `README.md`: setup, product summary and test commands.
