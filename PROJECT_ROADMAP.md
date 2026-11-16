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
| PR #20 uncertain notification retry confirmation | Verified merged | Merge `8e993c24313ad8c6f3b4b9bea0f135f64e42d0c5`; CI run `43872780296`: 72/72 pass, 0 fail, 0 skipped; warning/confirmation and audit tests pass |
| PR #22 registration back navigation/admin callback bypass | Verified merged | Merge `d5c5c394e2e486667d93051989210e14900162bb`; CI run `43873551353`: 76/76 pass, 0 fail, 0 skipped |
| PR #24 transactional support notifications | Verified merged | Merge `040b5951246cdcd4a14edd74bf7c03d0e2ef7803`; PR CI `43873852629`: 79/79 pass; merge CI `43874085107` passed |
| PR #26 snapshot-bound uncertain notification retry | Verified merged | Merge `9cecaea58647e68831acc8cf35f8b8fba89b7f02`; CI run `43875885637`: 82/82 pass, 0 fail, 0 skipped; syntax checks pass; MySQL integration covers stale snapshots, bounded batches, audit and concurrent confirmation |
| PR #27 manual retry diagnostic length bound | Verified merged | Merge `d4c7338a8d747e7d867120bf49a0e949701d4b18`; CI run `43876470137`: 82/82 pass, 0 fail, 0 skipped; syntax checks pass; no schema change |
| PR #7 resumable installer/reliability | Open Draft; CI green on current head | PR #7 targets `rebuild/telegram-native-v1`; operational branch head `d4c7338a8d747e7d867120bf49a0e949701d4b18`; not merged to base and not evidence of VPS deployment |
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
| P0 | Customer registration/profile | PR #17 and PR #22 merged; active-staff bypass covers all registration entry points, and users can navigate back across all three registration steps | Native contact request; sender/contact user ID match; E.164 normalization; duplicate prevention; cancellation/back navigation; server-side registration gate; profile view and edit-request approval |
| P0 | Campaign lifecycle | PR #39 merged idempotent pause/activate actions; PR #51 adds transactional, single-use campaign creation confirmation (111/111 CI) | Draft default; preview; validated state transitions; schedule boundaries; pause/close; no silent reopening; capacity and code limits; Tehran/Jalali input with UTC storage |
| P0 | Campaign creation idempotency | Verified merged; PR #51 CI run 43906419182 passed 111/111, 0 failures/skips | Locks the wizard, creates the draft, writes the audit record and consumes the wizard in one transaction; concurrent confirmation and invalid-schedule rollback covered; no schema change |
| P0 | Free entry and codes | Entry service and campaign-code model exist | One entry per profile/campaign; unique ticket codes; transactional issuance; immutable profile snapshot; concurrent capacity test; retry/idempotency |
| P0 | Paid orders and receipt review | PR #42 fixes expired-order reissue within the existing one-order-per-entry constraint; PR #45 preserves immutable amount/currency on reissue. CI runs 43901461881 (102/102) and 43903215825 (103/103) pass; direct-expiry, expiry-worker, receipt retention and amount immutability are covered. | Complete customer-to-admin-to-customer acceptance; verify immutable snapshot per attempt, stable reference per attempt, duplicate receipt handling, approve/reject idempotency, code issuance only after approval, rejection resubmission, and live expiry notification behavior |
| P0 | Capacity and expiry | Reservation/expiry behavior documented and worker exists | Atomic reserve/release under concurrency; 24-hour expiry; scheduled worker recovery; cancellation/expiry notifications; no capacity leak or double release |
| P0 | Admin authorization | PR #17 and PR #22 active-staff registration bypass is merged and CI-verified; full role-isolation acceptance remains | Deny-by-default for every callback/text/photo path; test each role with separate accounts; last-super-admin protection; audit history; session expiry/recovery |
| P0 | Telegram update reliability | Idempotency, rate limit and correlation controls described in README | Duplicate update test; stale webhook recovery without dropping pending updates; crash-window recovery; callback replay/concurrent admin action test; per-user rate-limit correctness |
| P0 | Notification outbox | PR #20 merged warning/confirmation; PR #26 merged queue-snapshot binding, 100-row transactional batches and concurrency guard (82/82 CI); PR #27 caps diagnostic text to avoid SQL truncation failure (82/82 CI); PR #35 adds bounded failed-row retry (92/92 CI); PR #37 moves ambiguous network/timeout/5xx failures to uncertain instead of auto-resending (97/97 CI) | Lease expiry/recovery; attempt history; dead-letter/failed visibility; **pre-action confirmation** for uncertain delivery; correlation; no false exactly-once guarantee |
| PR #32 support session idempotency | Verified merged | Merge `4a3491f875c1be919c8a5a14c4a4209e73164130`; CI run `43877732503`: 87/87 pass, 0 fail, 0 skipped; syntax checks pass; no schema change |
| PR #35 failed notification retry confirmation | Verified merged | Merge `d4410c5fbb3f65dd7d56497d4a3d851cdc04c5f1`; CI run `43878848630`: 92/92 pass, 0 fail, 0 skipped; syntax checks pass; no schema change |
| PR #39 campaign status transition idempotency | Verified merged | Merge `0f54087a9d87e3594c7e3eda9165cdf0d026f756`; CI run `43881174827`: 101/101 pass, 0 fail, 0 skipped; syntax checks pass; no schema change |
| PR #37 ambiguous Telegram delivery classification | Verified merged | Merge `07134d360fd73b28a1df8c450e39377512139d3c`; CI run `43879870265`: 97/97 pass, 0 fail, 0 skipped; syntax checks pass; no schema change |
| PR #42 expired paid order reissue | Verified merged | Merge `e3c4b4e6f8da2c269a98ff0efee17ea054760102`; CI run `43901461881`: 102/102 pass, 0 fail, 0 skipped; direct-expiry and expiry-worker reissue tested; no schema change |
| PR #44 CSV formula-injection hardening | Verified merged | Merge `ba03caa25d5b788f66ef21a93ab4924894ff60bd`; CI run `43902730419`: 103/103 pass, 0 fail, 0 skipped; Unicode whitespace, control characters and header escaping covered; no schema change |
| PR #45 immutable payment amount on reissue | Verified merged | Merge `39ac33a00f9ab95297c134cba67f94f0574dd34a`; CI run `43903215825`: 103/103 pass, 0 fail, 0 skipped; same-row expiry reissue preserves amount/currency and audits prior attempt; no schema change |
| PR #49 migration lock connection lifecycle | Verified merged | Merge `72c4794bfd0129555b04ecee5e2701e0b02c7d36`; final-head CI run `43905298261`: 109/109 pass, 0 fail, 0 skipped; syntax checks pass; no schema changes |
| P1 | Support | PR #24 makes admin alerts transactional; PR #32 prevents concurrent reuse of one-shot support sessions (87/87 CI) | Create/list/detail/reply/close/reopen; categories/priorities; assignment; full message history/pagination; authorization; transactional notifications and audit history |
| P1 | Reports and CSV | PR #44 hardens formula neutralization against leading Unicode whitespace and applies safe quoting to headers; CI run 43902730419 passed 103/103. | Recheck report aggregate semantics, bounded exports, PII minimization, date/time correctness and CSV output in target spreadsheet applications |
| P1 | Security and privacy | Rate limiting, audit, correlation and config validation documented | Threat review; ownership checks; secret/log redaction; input validation; abuse limits; data retention; admin recovery |
| P1 | Architecture boundaries | Direct SQL remains in Telegram handlers such as `user.handler.js`, `payment.handler.js` and `admin.handler.js`, contrary to `docs/ARCHITECTURE.md` | Move query/transaction logic behind domain services/repositories without changing behavior; add service-level tests and handler contract tests |
| P1 | Operational recovery | PR #49 closes the migration advisory-lock connection lifecycle gap (109/109 CI); installer, migrations, systemd and diagnostics documented | Isolated clean install; safe resume; migration lock/partial DDL recovery; service restart/start failure diagnosis; recovery/rollback rehearsal |
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
5. Complete operator-level acceptance of the paid order/receipt approval/expiry lifecycle after PR #42; CI now covers same-row order reissue, fresh references, bank-card refresh, retained receipt history and capacity restoration, but live Telegram smoke testing remains pending.
6. Verify role isolation and callback authorization using separate test admin accounts.
7. Verify update idempotency, rate limits, outbox recovery and manual retry warnings.
8. Complete support and reporting/CSV acceptance.
9. Run isolated MySQL integration, concurrency and load tests.
10. Revisit deferred product scope only with explicit owner decisions.
