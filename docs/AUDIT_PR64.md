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
