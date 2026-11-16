# UStore Telegram Bot — Roadmap, Audit Ledger and Work History

> Evidence-based status ledger. This file deliberately distinguishes code presence, test evidence, deployment evidence and real Telegram acceptance. Last expanded: 2026-11-16. Re-check current source/CI/VPS before relying on any dated status.

## Status definitions

- **Verified complete** — acceptance criteria and relevant verification evidence are documented.
- **Implemented; acceptance pending** — code exists, but end-to-end or required test evidence is incomplete.
- **Deployed; runtime verification pending** — operator evidence confirms deployment/startup, but user-facing behavior still needs a smoke test.
- **Needs audit** — related code exists, but full criteria, authorization, concurrency and failure paths have not been re-audited.
- **Blocked** — requires an external decision, credential, environment or owner action.
- **Deferred by decision** — explicitly outside the current release; do not implement without approval.

## 1. Release baseline and recorded milestones

| Milestone | Status | Evidence / qualification |
|---|---|---|
| Telegram-native Node.js/Telegraf + MySQL direction | Current product direction | README and current project context; no Telegram Business or web panel in this release |
| Normalized multi-campaign model | Implemented; acceptance pending | Current scope and source domains; full end-to-end acceptance still required |
| PR #11 receipt photo notification/outbox support | Historical merged milestone | Operator-reported test snapshot: 34 pass, 0 fail, 18 skipped; skipped MySQL integration tests were not executed |
| PR #12 Persian newline fix | Verified merged | Commit `69b12dc6a2d5d40969d37d6eb109eb4e71e2f15e` |
| PR #13 Jalali/Tehran date-time | Merged; manual acceptance pending | Merge `ee2a85cfd886145547310ec845fff68036fd4ea2`; CI run 43754409445: 56/56 passed |
| PR #13 VPS test snapshot | Verified with caveat | Date-time 4/4; `npm test` 38 pass, 0 fail, 18 skipped (MySQL integration skipped) |
| PR #13 service startup | Deployed; runtime verification pending | Operator supplied active/running, DB connected, long polling startup output at that time |
| PR #14 project documentation | Verified merged | Docs-only merge `65cae7585fcb8bde5f4d837fa173715e6717c12f`; no app/DB/VPS/service change |
| PR #16 campaign-specific sequential codes | Verified merged; production migration pending | Merge `193602976e1d29c4de5e9d3b1ac4b96a13eee7c3`; CI run `43871251991`: 64/64 pass, 0 fail, 0 skipped; syntax checks pass. Approved test participation/payment/draw cleanup is in the migration but has not been applied to VPS/production |
| PR #17 active-admin registration bypass | Verified merged; VPS deployment pending | Merge `b269c280c1beade14c2ef1d7d56321bc59edbb34`; CI run `43872103482`: 70/70 pass, 0 fail, 0 skipped; syntax checks pass. Covers configured admins, active/inactive staff, ordinary users, missing identity, both contact/text handlers and permission-store failure |
| PR #18 project handoff refresh | Verified merged; documentation only | Merge `14c09717bef200aca05193a5416a98bc0107493c`; CI run `43872431924` successful; no app/DB/VPS change |
| PR #20 uncertain notification retry confirmation | Implemented; CI pending | Draft PR `fix/outbox-uncertain-retry-confirmation-v2`; super-admin must confirm after seeing duplicate-delivery warning before uncertain rows are re-queued |
| PR #7 resumable installer/reliability | Open Draft; CI green on current head | PR #7 targets `rebuild/telegram-native-v1`; operational branch head `14c09717bef200aca05193a5416a98bc0107493c`; not merged to base and not evidence of VPS deployment |
| Expanded project-history documentation | In progress in this PR | This update; documentation only, no runtime action |

## 2. Immediate operator verification

These are real-world checks that CI cannot replace. Use draft/disposable records and test accounts only.

1. **Jalali campaign display:** campaign list/detail show Persian calendar and 24-hour Tehran time.
2. **Jalali campaign input:** create/edit only a disposable draft; verify valid input, invalid dates, start/end/draw ordering and UTC round-trip.
3. **Other timestamp surfaces:** inspect participant history, order, payment receipt, support ticket and admin notifications where timestamps appear.
4. **CSV timestamps:** inspect actual exported timestamp columns and expected timezone/calendar behavior.
5. Record date, bot version/commit, test account, exact scenario, expected/actual result and redacted evidence. Do not use a live paid order or active campaign for testing.

## 3. Product acceptance audit backlog

The table below is an audit plan, not a claim that all functionality is complete. For each item, inspect source, tests, authorization, transaction boundaries, race conditions, recovery and real Telegram UX.

| Priority | Area | Current evidence | Required acceptance / audit |
|---|---|---|---|
| P0 | Customer registration/profile | Registration, participant modules and contact rules documented; PR #17 fixes active staff being intercepted by stale customer sessions (pending CI) | Native contact request; sender/contact user ID match; E.164 normalization; duplicate prevention; cancellation/back navigation; server-side registration gate; profile view and edit-request approval |
| P0 | Campaign lifecycle | Campaign service/repository/scheduler exist | Draft default; preview; validated state transitions; schedule boundaries; pause/close; no silent reopening; capacity and code limits; Tehran/Jalali input with UTC storage |
| P0 | Free entry and codes | Entry service and campaign-code model exist | One entry per profile/campaign; unique ticket codes; transactional issuance; immutable profile snapshot; concurrent capacity test; retry/idempotency |
| P0 | Paid orders and receipt review | Payment/bank-card modules and receipt notifications exist | Full customer-to-admin-to-customer flow; immutable amount/card snapshot; stable payment reference; duplicate receipt handling; approve/reject idempotency; code issuance only after approval; rejection resubmission |
| P0 | Capacity and expiry | Reservation/expiry behavior documented and worker exists | Atomic reserve/release under concurrency; 24-hour expiry; scheduled worker recovery; cancellation/expiry notifications; no capacity leak or double release |
| P0 | Admin authorization | Roles, permissions and sessions documented; PR #17 adds a focused active-staff registration bypass fix (pending CI) | Deny-by-default for every callback/text/photo path; test each role with separate accounts; last-super-admin protection; audit history; session expiry/recovery |
| P0 | Telegram update reliability | Idempotency, rate limit and correlation controls described in README | Duplicate update test; stale webhook recovery without dropping pending updates; crash-window recovery; callback replay/concurrent admin action test; per-user rate-limit correctness |
| P0 | Notification outbox | Leased worker, bounded retries and manual retry documented; uncertain retry currently warns after it has already been queued | Lease expiry/recovery; attempt history; dead-letter/failed visibility; **pre-action confirmation** for uncertain delivery; correlation; no false exactly-once guarantee |
| P1 | Support | Customer/admin ticket flows exist in handlers; new-ticket and customer-reply admin notifications were queued after commit, risking a saved ticket with a failed user response and no admin alert; follow-up moves enqueue into the same transaction | Create/list/detail/reply/close/reopen; categories/priorities; assignment; full message history/pagination; authorization; transactional notifications and audit history |
| P1 | Reports and CSV | Management reports/CSV modules and tests exist | Correct aggregates; pagination and bounded exports; UTF-8 BOM; formula-injection safety; PII minimization; date/time correctness |
| P1 | Security and privacy | Rate limiting, audit, correlation and config validation documented | Threat review; ownership checks; secret/log redaction; input validation; abuse limits; data retention; admin recovery |
| P1 | Architecture boundaries | Direct SQL remains in Telegram handlers such as `user.handler.js`, `payment.handler.js` and `admin.handler.js`, contrary to `docs/ARCHITECTURE.md` | Move query/transaction logic behind domain services/repositories without changing behavior; add service-level tests and handler contract tests |
| P1 | Operational recovery | Installer, migrations, systemd and diagnostics documented | Isolated clean install; safe resume; migration lock/partial DDL recovery; service restart/start failure diagnosis; recovery/rollback rehearsal |
| P2 | Load and concurrency | Not established by the historical snapshots | Load test with isolated DB; contention tests for capacity, duplicate approval, update claims and notification leasing |
| P2 | Backup/restore | Not established by this history | Define retention, off-host backup, restore rehearsal, RPO/RTO and operator procedure before relying on production data |

### Completion gate for every P0/P1 item

- Requirement and expected behavior written down.
- Relevant source paths and data model inspected.
- Authorization, ownership, transactions, concurrency and error/retry paths reviewed.
- Focused regression tests pass.
- Full relevant suite and isolated MySQL integration suite results recorded; skipped tests listed separately.
- CI green on the exact PR head.
- Diff reviewed for secrets and unrelated changes.
- PR reviewed and merged.
- Production deployment separately approved and confirmed.
- Telegram/MySQL/scheduler/external-delivery smoke test completed where applicable.

## 4. Deferred scope — do not silently bring into this release

- Actual draw execution, winner selection and winner announcement workflow.
- Live payment gateway provider selection/integration and server-side gateway verification.
- Web administration panel.
- Campaign discovery filters/catalog search where marked deferred in `docs/COMPLETION_SCOPE.md`.
- Telegram Business integration.
- Instagram API integration or automatic follower verification.
- Any change to eligibility, payment/refund policy, prize allocation, code rules, campaign limits or win limits without explicit owner approval.
- Independent public commit/reveal draw proof is not part of the current release acceptance unless explicitly re-scoped.

## 5. Known historical test evidence — do not overstate

- PR #13 CI run `43754409445`: 56 tests passed, 0 failed; MySQL integration tests ran in CI's isolated environment.
- VPS after PR #13: `node --test tests/datetime.test.js` -> 4 passed.
- VPS `npm test` -> 38 passed, 0 failed, 18 skipped. The 18 MySQL integration tests were skipped, not passed.
- PR #11 operator snapshot: 34 passed, 0 failed, 18 skipped (52 total); integration tests skipped.
- These are dated historical results, not evidence about the current head or live service today.

## 6. Work-session update protocol

At the end of each task:
1. Update the relevant row above with exact status and evidence.
2. Add a dated milestone for merged changes; include PR/commit, focused tests, full tests and CI.
3. Distinguish source implementation, CI verification, VPS deployment and Telegram runtime verification.
4. Record failures and skips; append the resolution rather than erasing history.
5. Update `PROJECT_CONTEXT.md` if product decisions, architecture or invariants changed.
6. Update `DEPLOYMENT.md` if server layout, commands, dependencies, migration or release procedure changed.
7. If a requirement is deferred or blocked, retain it visibly with the reason.
8. Do not label a task complete based only on code generation, source presence, a passing unit test or a successful GitHub merge.

## 7. Next recommended sequence

1. Reconcile the actual VPS branch/HEAD/service state with the GitHub operational branch using read-only preflight output.
2. Before any production migration, verify the exact row counts in every table covered by PR #16's approved test-data cleanup; stop if any row is not disposable test data.
3. Complete the Jalali/Tehran live Telegram smoke tests using disposable data.
4. Perform a source-to-acceptance audit of P0 customer registration, campaign lifecycle, free entries/codes and capacity concurrency.
5. Audit the complete paid order/receipt approval/expiry lifecycle before any paid campaign is enabled.
6. Verify role isolation and callback authorization using separate test admin accounts.
7. Verify update idempotency, rate limits, outbox recovery and manual retry warnings.
8. Complete support and reporting/CSV acceptance.
9. Run isolated MySQL integration, concurrency and load tests.
10. Revisit deferred product scope only with explicit owner decisions.
