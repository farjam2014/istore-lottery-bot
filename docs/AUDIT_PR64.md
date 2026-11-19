# UStore Repository Audit — PR #64 Baseline

Date: 2026-11-19

## Baseline and recovery

- Baseline merge commit: `4615a6163f22752cf5fe408904ef85786ca7e8e4`
- PR: #64
- Recovery branch: `backup/pr-64-pre-audit`
- Audit branch: `audit/pr64-clean-rebuild`
- No server or existing database was used or modified during this audit.

## Audit rules

1. GitHub repository content at the baseline is the source of truth.
2. Target deployment is a brand-new Ubuntu server and a fresh MySQL database.
3. Findings are not considered fixed until a code change, test, and verification evidence exist.
4. No destructive integration tests may run against a production or existing bot database.
5. Separate source-code findings from CI/test-environment gaps and deployment findings.

## Initial findings

### AUDIT-001 — Audit branch is not covered by current CI branch filters
**Severity:** Process / Medium

The workflow's push filters and pull-request base filters do not include `audit/pr64-clean-rebuild`. Commits on this branch will not automatically receive the configured CI run unless a workflow change or another trigger is introduced.

**Evidence:** `.github/workflows/ci.yml`

**Status:** Resolved on audit branch by commit `2abbf347de7ad413fa226f8f4724fd56aeb71e1c`, which adds the audit branch to push and pull-request filters. CI run `44519309580` succeeded.

### AUDIT-002 — Installer's test phase does not run MySQL integration tests
**Severity:** Deployment validation / High

The installer runs `npm test` before provisioning the application database and does not set `RUN_MYSQL_TESTS=1`. The MySQL integration tests are therefore skipped during installer execution. The installer then applies migrations and starts the service, but does not run a dedicated post-migration smoke test.

**Evidence:** `install.sh`, `package.json`, `.github/workflows/ci.yml`

**Status:** Open. Design a safe fresh-install verification stage.

### AUDIT-003 — Integration DB preparation script does not provision the restore-test database permissions
**Severity:** Test environment / Medium

The backup/restore integration test creates a second database and imports a dump into it using the configured MySQL application user. `scripts/prepare-integration-db.sh` grants privileges on the primary disposable test database only. CI uses a privileged MySQL root user, which may conceal this mismatch when the script is used with the restricted application account.

**Evidence:** `tests/integration/draw-keyring-backup-restore.test.js`, `scripts/prepare-integration-db.sh`, CI MySQL environment.

**Status:** Open. Verify and redesign test privilege setup so elevated privileges are isolated to test infrastructure, not runtime credentials.

### AUDIT-004 — Baseline CI execution evidence is not yet verified
**Severity:** Validation / Medium

The test suite and CI workflow exist. However, no successful workflow run has been confirmed for the exact baseline merge commit during this audit.

**Status:** Verified by successful CI run `44519309580` on audit-branch commit `2abbf347de7ad413fa226f8f4724fd56aeb71e1c`, which is based on the exact PR #64 baseline and includes only the CI trigger adjustment. MySQL integration tests were enabled in that workflow.

## Positive controls observed

- Migration execution is disabled by default and requires explicit authorization.
- Test migrations require a disposable database suffix and loopback host.
- Production migration target must exactly match the configured database.
- The installer refuses tracked local modifications and unexpected repository ownership/origin.
- Existing `.env` is preserved and not printed.
- Installer does not contain database-drop or recursive-delete commands.
- CI config provisions MySQL 8 and explicitly enables MySQL integration tests.
- Integration coverage includes concurrent capacity checks, concurrent payment approval, idempotency, code issuance rollback, outbox behavior, campaign scheduling, and draw integrity.

## Next audit areas

1. Migration clean-install, replay, partial-DDL recovery, and legacy-data compatibility.
2. Payment/order lifecycle and concurrency invariants.
3. Campaign capacity and free-entry idempotency.
4. Draw preparation, publication commitment, seed/key recovery, proof verification, and relational integrity.
5. Admin authorization and callback routing.
6. Notification outbox failure/retry/uncertain-delivery behavior.
7. Installer resume/failure recovery and fresh-server smoke test.
8. Security and secret handling.

### AUDIT-005 — Public draw proof contains internal participant identifiers
**Severity:** Privacy / Medium

The offline proof artifact intentionally excludes names, phone numbers, Instagram handles, Telegram IDs, and the publishing administrator's Telegram ID, but it includes numeric internal participant IDs so the verifier can enforce unique-participant winners. The documentation already warns that this is not anonymous data.

**Evidence:** `src/modules/draw/draw-proof.service.js`, `docs/VERIFIABLE_DRAWS.md`

**Status:** Risk acknowledged; decide whether public proof needs stable pseudonyms or a separate privacy-preserving uniqueness scheme.

### AUDIT-006 — Publication attestation is not independently verified
**Severity:** Integrity / Medium

The draw workflow requires an HTTPS publication reference and stores the reference, timestamp, and admin attestation. The validator does not fetch the URL or verify that the commitment/snapshot hashes were actually published there or remained unchanged. This limitation is explicitly documented.

**Evidence:** `src/modules/draw/draw-verifier.js`, `src/modules/draw/draw-proof.service.js`, `docs/VERIFIABLE_DRAWS.md`

**Status:** Product trust limitation; assess campaign transparency requirements before release.

### AUDIT-007 — Installer and CI use non-clean dependency installation
**Severity:** Reproducibility / Medium

The installer and CI originally used `npm install` despite a committed package lock. This can reconcile or modify dependency resolution rather than enforcing the exact lockfile state.

**Change:** Replaced with `npm ci --omit=dev` in the installer and `npm ci` in CI.

**Verification:** CI run `44519626338` succeeded on commit `859b94da2f9a8934395a6976b1874ff3d4656250`, including npm ci, the full test command, JavaScript syntax checks, and Bash syntax check.

**Status:** Resolved on audit branch; draft PR #67.

### AUDIT-008 — Telegram update claim can become permanently stuck after process crash
**Severity:** Reliability / High

The update guard inserts an update ID into `processed_updates` before handler execution. It removes the claim on caught exceptions, but there is no processing state or lease. If the process terminates after the insert and before successful handler completion, the same update is treated as already processed if it is retried, and the handler is skipped.

**Evidence:** `src/bot/middleware/update-guard.js`, `tests/unit/update-guard.test.js`, `src/database/schema.sql`

**Status:** Open. Design crash recovery without introducing duplicate financial or campaign actions; requires durable inbox state, lease/recovery semantics, and business-level idempotency tests.

### AUDIT-009 — Campaign field-edit wizard cannot persist its step on PR #64 baseline
**Severity:** Functional / High

The admin handler stores `campaign_edit_value` in `admin_wizards.step`, but the baseline schema/migrations did not include that ENUM value. MySQL rejects the wizard state write, so campaign field editing fails.

**Evidence:** `src/bot/handlers/admin.handler.js` and baseline `admin_wizards.step` ENUM in `src/database/schema.sql` plus migrations.

**Change on audit branch:** Added `20261119_001_campaign_edit_wizard_step.sql`, a preflight/replay guard in `src/database/migrate.js`, and integration coverage for persistence and migration-history replay.

**Status:** Fix implemented and verified by CI run `44519921332` on commit `1c7756b661e2d9189bd17b2a8a1f3a0737978b05`. The MySQL integration suite, npm ci, JavaScript syntax checks, and Bash syntax check all passed.

### AUDIT-010 — Eligible campaign can be archived before a draw
**Severity:** Business integrity / High

The archive service allowed a closed campaign to be archived when it had no prepared/completed draw and no open payment orders, even if eligible entries remained. Since draw preparation requires a campaign to be closed, archiving such a campaign permanently prevented the draw workflow.

**Change on audit branch:** Archive now refuses while any eligible entries remain. The integration test verifies the prepared-draw guard, the eligible-entry guard after cancelling a draw, and archive success only after the entry is disqualified.

**Status:** Fix implemented and verified by CI run `44520666389` on PR merge commit `bf849463975b93aa39633496e67c588ed8bc0702`.

### AUDIT-011 — Campaigns without an end date could never be closed for drawing
**Severity:** Business integrity / High

Campaign creation allows `ends_at` to be null. The scheduler only closes open campaigns whose end date has passed, and the admin toggle only switches open to paused. Draw preparation requires `closed`, so campaigns without an end date had no UI path to draw readiness.

**Change on audit branch:** Added explicit manual closure for open, paused, or scheduled campaigns. It locks the campaign, records an audit event, and transitions to `closed`. The admin campaign detail now exposes the close action separately from pause/resume.

**Test:** MySQL integration test covers closing an open campaign with no end date and rejects an invalid repeat close.

**Status:** Fix implemented and verified by CI run `44520666389` on PR merge commit `bf849463975b93aa39633496e67c588ed8bc0702`.

### AUDIT-012 — CI does not scan production dependency advisories
**Severity:** Security / Medium

The CI workflow originally ran tests and syntax checks but did not scan the production dependency tree for known advisories.

**Change on audit branch:** Added `npm audit --omit=dev --audit-level=high` after lockfile-exact installation.

**Status:** Implemented and verified by CI run `44520666389`; `npm audit --omit=dev --audit-level=high` succeeded.

### AUDIT-013 — Support-ticket notification was outside the ticket transaction
**Severity:** Reliability / Medium-High

New support tickets and customer replies were committed before their admin notification was inserted into the outbox. If the notification insert failed, the support message persisted but the admin could receive no notification.

**Change on audit branch:** Admin notifications for new tickets and customer replies are now enqueued using the same transaction executor as the ticket/message/session changes. Failure rolls back the business operation instead of leaving an unnotified ticket.

**Test:** Added MySQL integration coverage for support-ticket and outbox rollback/commit atomicity.

**Status:** Fix implemented; CI verification pending.

### AUDIT-014 — Registration `/cancel` intercepted admin role-session cancellation
**Severity:** UX / Low

The registration handler registered `/cancel` before the admin handler and returned without calling `next()`, so configured super-admins could not use the admin role-session command cancellation through text. The inline cancel button still worked.

**Change on audit branch:** Configured super-admins now pass the registration cancellation command to the admin handler.

**Status:** Fix implemented; CI verification pending.
