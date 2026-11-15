# UStore Telegram Bot — Roadmap and Verification Ledger

> This is a status ledger, not a claim that every product requirement is complete. Update each item only when backed by source review, tests, CI or operator-confirmed runtime evidence. Last snapshot: 2026-11-15.

## Status legend

- **Verified complete** — implementation and the stated verification evidence exist.
- **Deployed; runtime verification pending** — deployed according to operator output, but user-facing behavior still needs a live test.
- **Needs audit** — source contains related code, but completeness/acceptance has not been re-established in the current audit.
- **Deferred by decision** — intentionally not part of the current release.
- **Blocked** — cannot proceed without an external decision, access or dependency.

## Current release baseline

| Item | Status | Evidence / note |
|---|---|---|
| Production branch PR #13 merged | Verified complete | Merge commit `ee2a85cfd886145547310ec845fff68036fd4ea2` |
| PR #13 CI | Verified complete | Run 43754409445; 56/56 tests passed, including MySQL integration in CI |
| PR #13 deployed to VPS | Deployed; runtime verification pending | Operator confirmed checkout SHA, restart, active service, DB connection and Telegram long polling |
| Jalali/Tehran display in real Telegram conversations | Deployed; runtime verification pending | Still requires manual end-to-end checks listed below |
| VPS non-integration test run | Verified complete with caveat | 38 passed, 0 failed, 18 skipped; skipped integration tests were not executed |
| Web-panel date/time behavior | Deferred / out of scope | PR #13 scope was Telegram bot only |

## Immediate next actions

1. **Live Telegram smoke test for Jalali dates** — inspect campaign list/details and ensure dates are Jalali with 24-hour Tehran time.
2. **Jalali campaign input test** — use a disposable/draft campaign; verify accepted input, invalid dates, date ordering and saved/displayed UTC round-trip.
3. **Related timestamp surfaces** — verify order, payment receipt, participant history, support/ticket history and admin messages where dates are rendered.
4. **CSV date output** — inspect actual export fields and verify expected calendar/timezone behavior if timestamp columns are included.
5. Record screenshots or redacted message samples and update this ledger with exact test evidence. Do not test by mutating a live campaign or real customer payment.

## Product capability audit

The current source tree contains modules for the areas below. Their presence is not proof of complete acceptance. Re-audit code paths, authorization, transactions, failure handling and tests before marking complete.

| Area | Current evidence | Next audit focus |
|---|---|---|
| Customer registration/profile | registration, participant modules and registration middleware exist | contact ownership validation, required fields, duplicate handling, edit-request approval, blocked users |
| Campaign management | campaign service/repository and scheduler exist | draft defaults, transitions, capacity rules, schedule boundaries, invalid date ordering, concurrency |
| Free entries/codes | entry service exists | duplicate-entry prevention, atomic capacity, code uniqueness, snapshot immutability |
| Paid orders | payment service and bank-card service exist | full customer/admin flow, reservation expiry/release, immutable order/card snapshot |
| Receipt review | payment callbacks/admin services and receipt-notification delivery exist | duplicate receipt behavior, idempotent approval/rejection, retry/re-submit paths, code issuance only after approval |
| Notifications | outbox service/worker and Telegram delivery module exist | lease recovery, bounded retries, uncertain delivery, duplicate warnings, delivery history |
| Admin access | permission, role and session modules exist | deny-by-default callback coverage, role isolation, super-admin recovery and session expiry |
| Support | support migration exists; verify handlers/services in current tree | full ticket lifecycle, assignment, message persistence, permissions and notifications |
| Reports/CSV | management report service and CSV tests exist | correct aggregates, pagination/limits, formula-injection safety, PII minimization, date formatting |
| Security/reliability | rate-limit, update guard, correlation and delivery-history migrations exist | threat review, race tests, log redaction, abuse controls, operational recovery |

## Deferred scope — do not silently implement as if approved

- Draw execution and winner selection workflow.
- Live payment-gateway integration; provider selection and server-side verification remain future work.
- Web administration panel.
- Campaign discovery filters/catalog search where the acceptance document marks them deferred.
- Any change to business rules such as paid/free eligibility, refund policy, prize allocation or participant win limits without owner approval.

See `docs/COMPLETION_SCOPE.md` for the authoritative product acceptance plan. If this roadmap and the source disagree, investigate and report the discrepancy; do not silently rewrite product decisions.

## Definition of done

A task is complete only when all applicable gates pass:

1. Requirement and acceptance criteria are explicit.
2. Relevant code paths and dependencies are inspected.
3. Implementation is reviewed for authorization, data ownership, transactions, concurrency, error handling and logging.
4. Focused tests are added/updated and pass.
5. Full relevant test suite passes; skipped tests are reported separately.
6. CI is green on the exact commit/PR head.
7. Diff is reviewed; no unrelated or secret-bearing changes are included.
8. PR is merged only after review/CI.
9. Production deploy is separately approved and confirmed.
10. Runtime smoke test is completed where behavior depends on Telegram, MySQL, scheduler or external delivery.

## How to maintain this file

- Add newly discovered work to the relevant area with a priority and a concrete acceptance test.
- Mark an item **Verified complete** only with a link/commit/test command and result.
- Keep deferred items deferred unless the owner changes scope.
- Do not delete failed-test history; append the resolution and evidence.
- At the end of each work session, update this file and `PROJECT_CONTEXT.md` if architecture or product decisions changed.
