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

**Change on audit branch:** The backup/restore test now uses explicit `MYSQL_TEST_ADMIN_USER`/`MYSQL_TEST_ADMIN_PASSWORD` for creating, importing into, connecting to, and dropping the isolated restore database; source dumps still use the configured application user. CI explicitly configures the test admin. **Status:** Fix implemented and verified by CI run `44524907223`. Backup/restore operations now use explicit test-admin credentials, and CI supplies the admin account. The runner now reads application settings through dotenv rather than assuming shell-exported variables. The first CI run caught an incorrect static assertion regex; that test assertion was corrected.

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

The update guard inserts an update ID into `processed_updates` before handler execution. It removes the claim on caught exceptions, but there is no durable inbox payload, processing state, or lease. Telegraf polling advances the update offset before handler completion; a process crash can therefore lose an update permanently. The guard's caught-exception release does not provide crash recovery.

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

**Status:** Fix implemented and verified by CI run `44521519922` on commit `04dfa2426b948015f0ce71bd9c54ae0df882f2f2`.

### AUDIT-014 — Registration `/cancel` intercepted admin role-session cancellation
**Severity:** UX / Low

The registration handler registered `/cancel` before the admin handler and returned without calling `next()`, so configured super-admins could not use the admin role-session command cancellation through text. The inline cancel button still worked.

**Change on audit branch:** Configured super-admins now pass the registration cancellation command to the admin handler.

**Status:** Fix implemented and verified by CI run `44521519922` on commit `04dfa2426b948015f0ce71bd9c54ae0df882f2f2`.

### AUDIT-015 — Installer could declare success without confirming Telegram polling launch
**Severity:** Deployment reliability / High

The installer originally checked only `systemctl is-active` after a fixed sleep. That did not prove the service was in `running` state or that Telegraf had successfully launched polling.

**Change on audit branch:** Startup now logs a success message only after `bot.launch()` resolves. Installer waits for ActiveState=active, SubState=running, a nonzero MainPID, and that fresh startup log message.

**Status:** Implemented and verified by CI run `44521519922` on commit `04dfa2426b948015f0ce71bd9c54ae0df882f2f2`.

### AUDIT-016 — Installer has no real fresh-server integration test
**Severity:** Deployment validation / High

Existing installer tests are static assertions plus `bash -n`. They do not provision Ubuntu, MySQL, the systemd unit, or execute a complete clean install.

**Status:** Open. Design a safe ephemeral clean-install test or a documented manual acceptance procedure; current CI cannot claim end-to-end installer verification.

### AUDIT-017 — Installer update failure has no automatic rollback
**Severity:** Recovery / Medium

On an existing checkout, the installer stops the service, updates source, replaces dependencies, and applies migrations. A failure leaves the service stopped and does not restore the previous source/dependency state. The installer is resumable but not transactional.

**Status:** Open. Fresh-server deployment is the current target; release-based deployment and rollback should be designed before updates to a live installation.

### AUDIT-018 — Draw preparation did not check active repeat payment orders
**Severity:** Business integrity / High

A participant with an already eligible entry could create a second paid order without changing the entry status to `pending_payment`. Draw preparation only checked that entry status, so an active `awaiting_receipt`, `under_review`, or unexpired `rejected` repeat order could be overlooked. A paid code from that order could be excluded from the draw snapshot.

**Change on audit branch:** Draw preparation now separately checks active payment orders using the same reservation statuses/expiry semantics as capacity accounting.

**Test:** Expanded MySQL integration test covers a first pending order and a repeat order under review on an already-eligible entry, then verifies draw preparation succeeds only after both are resolved.

**Status:** Fix implemented and verified by CI run `44522826747`; the initial test-fixture reference-length failure was corrected, and the rerun passed.

### AUDIT-019 — Draw proof is verifiable but not operator-proof
**Severity:** Transparency / High for public campaigns; design limitation

The seed is generated by the server and encrypted using a key available to the operator through configuration. The operator can decrypt the seed before the draw and calculate the result from the committed candidate snapshot. The current proof verifies consistency and deterministic ranking; it does not prevent a privileged operator from learning the outcome in advance, withholding a draw, or manipulating eligibility before commitment.

**Status:** Documented trust boundary. If the campaign promises operator-independent fairness, a future design should incorporate unpredictable external entropy revealed after the public commitment (for example, a specified public randomness beacon) and publish an independently reconciled eligibility register. This is not a small code fix and must be decided before making stronger fairness claims.

### AUDIT-020 — Draw service did not enforce the configured draw time
**Severity:** Business integrity / Medium-High

Campaign creation and editing validate that `draw_at` is not before `ends_at`, and the campaign UI displays the configured draw time. However, the draw preparation service did not enforce `draw_at`, allowing an administrator to manually close and prepare a draw before its configured time.

**Change on audit branch:** Draw preparation now locks and reads the configured `draw_at` and rejects preparation while that time is in the future.

**Test:** Added MySQL integration coverage verifying a future draw time prevents preparation and creates no draw row.

**Status:** Fix implemented and verified by CI run `44522826747`.

### AUDIT-021 — Manual integration test command did not select the prepared test database
**Severity:** Test safety / High

`prepare-integration-db.sh` creates `MYSQL_TEST_DATABASE`, but the integration runner reads `MYSQL_DATABASE` from the application environment. The documented `npm run test:integration` command did not override it or authorize test migrations, so it could fail or target the wrong database if the application database name happened to pass the test suffix guard.

**Change on audit branch:** Added `scripts/run-integration-tests.sh`. It requires an explicit disposable `MYSQL_TEST_DATABASE`, verifies it differs from `MYSQL_DATABASE`, restricts MySQL to loopback, sets test-only migration authorization, and uses explicit admin credentials for the isolated backup/restore database. Updated `package.json`, static tests, and README instructions.

**Status:** Fix implemented and verified by CI run `44524907223`.

### AUDIT-022 — Archive guard counted expired rejected orders as open
**Severity:** Workflow correctness / Medium

Archive checks treated every rejected order as pending, even after its reservation expiry. This could block archiving a campaign after the order's 24-hour window had elapsed, despite capacity accounting no longer reserving it.

**Change on audit branch:** Archive now uses the same active-reservation semantics as capacity accounting: under-review orders always count; awaiting-receipt/rejected orders count only while their expiry is in the future.

**Test:** Extended campaign archive integration coverage with an expired rejected order.

**Status:** Fix implemented and verified by CI run `44524907223`.

## Latest verification snapshot

- CI run: `44525346581`
- `npm ci`: successful
- `npm audit --omit=dev --audit-level=high`: successful
- Main test suite: 128 passed, 0 failed, 0 skipped
- Draw keyring backup/restore integration: 1 passed, 0 failed, 0 skipped
- JavaScript syntax checks: successful
- Bash syntax checks for installer and integration setup/runner: successful
- No deployment or server/database mutation performed

## Open items requiring design or fresh-server validation

1. **Durable Telegram inbox / crash recovery:** update handlers are not replayed from a durable payload after a process crash. Releasing an update claim on a caught exception is not crash recovery.
2. **Fresh Ubuntu installation:** CI verifies code, MySQL integrations, and installer syntax, but does not boot a fresh Ubuntu VM and run the complete installer/systemd flow.
3. **Rollback for in-place updates:** installer can leave service stopped and checkout/dependencies updated after a failure; fresh-server install is the current target, but live-update rollback needs a separate design.
4. **Operator-independent draw fairness:** current seed is accessible to the server operator; external post-commit entropy and an independently reconciled eligibility register are required for stronger claims.
5. **Public proof privacy/reconciliation:** proof artifacts include internal participant identifiers and do not independently prove the complete eligibility register; documented design boundary.
6. **Publication attestation:** the system stores an admin-provided publication reference but does not independently verify that the commitment was published before the draw.
