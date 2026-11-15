# UStore Telegram Bot — Deployment and Operations Runbook

> Operational runbook for the known VPS. Every value below is a dated snapshot until rechecked. GitHub merge is not deployment. No production action is authorized merely by reading or updating this document.

## 1. Known production environment snapshot

- Repository: `farjam2014/istore-lottery-bot`
- Operational branch: `install/resumable-ubuntu-v2`
- VPS checkout: `/opt/ustore-telegram-bot`
- OS: Ubuntu 24.04.5 LTS
- Runtime: Node.js 22.x
- Database: MySQL 8.0.x
- Service: `ustore-telegram-bot.service`
- Service user: `ustorebot`
- Working directory: `/opt/ustore-telegram-bot`
- ExecStart recorded: `/usr/bin/node /opt/ustore-telegram-bot/src/index.js`
- Last application-code commit explicitly recorded as deployed: `ee2a85cfd886145547310ec845fff68036fd4ea2` (PR #13).
- PR #14 commit `65cae7585fcb8bde5f4d837fa173715e6717c12f` added documentation only and did not require a VPS deployment.
- Operator previously supplied restart output showing active/running, database connection established and Telegram long polling startup. This is historical, not current health telemetry.
- Database name is supplied through server-side `MYSQL_DATABASE`; never print the full environment or password.

## 2. Authority and safety boundary

- Assistant has no implicit SSH/VPS access. Operator runs commands and shares sanitized output.
- Read-only diagnosis may be prepared without changing production.
- Production code deploy, migration, service restart, webhook change or data operation requires explicit owner approval for that action.
- GitHub branch/PR operations change GitHub only; they do not connect to the VPS.
- Do not run the installer/reset flow as a routine update.
- Do not run integration tests against the production database.
- Never expose `.env`, `BOT_TOKEN`, `MYSQL_PASSWORD`, private keys, full bank-card numbers, raw Telegram file tokens or participant payment data.

## 3. Read-only preflight

Run in an SSH session. Do not paste secrets.

```bash
cd /opt/ustore-telegram-bot
git status --short --branch
git branch --show-current
git rev-parse HEAD
git remote -v
```

Inspect service metadata without environment values:

```bash
SYSTEMD_PAGER=cat systemctl show --no-pager ustore-telegram-bot.service \
  -p User -p WorkingDirectory -p ExecStart -p EnvironmentFiles \
  -p MainPID -p ActiveState -p SubState -p ActiveEnterTimestamp
```

Check configured DB name without exposing it:

```bash
grep -E '^MYSQL_DATABASE=' .env | sed 's/=.*/=<configured>/'
```

Check runtime/dependency state:

```bash
node --version
npm --version
npm ls --depth=0
```

Check service status/logs (sanitize before sharing):

```bash
systemctl is-active ustore-telegram-bot.service
journalctl -u ustore-telegram-bot.service -n 60 --no-pager
```

Stop and investigate if the working tree has tracked local changes, the branch is unexpected, the service unit differs, or untracked files may be overwritten. Never force-reset to make the checkout look clean.

## 4. Known fetch refspec issue

A prior VPS session found that `remote.origin.fetch` did not track `install/resumable-ubuntu-v2`; ordinary `git fetch origin` did not refresh its remote-tracking ref. The explicit fetch that worked was:

```bash
git fetch origin +refs/heads/install/resumable-ubuntu-v2:refs/remotes/origin/install/resumable-ubuntu-v2
```

Then, only after verifying branch and working tree:

```bash
git merge --ff-only origin/install/resumable-ubuntu-v2
```

Do not assume this refspec remains unchanged; inspect it first. Do not use `git reset --hard`, force push or overwrite local work.

Historical untracked items included `.lesshst`, `.npm/` and `package-lock.json`. They were intentionally left untouched. Inspect ownership and purpose before changing any such item.

## 5. Test and database safety

Safe production-local checks previously used:

```bash
node --test tests/datetime.test.js
npm test
```

These commands do not replace isolated integration tests. At the 2026-11-15 snapshot, VPS `npm test` reported 38 passed, 0 failed, 18 skipped; skipped tests were MySQL integration tests and did not run.

Integration tests can mutate schema and rows. Use only a disposable MySQL database with a name ending in `_ci` or `_test`, for example an isolated CI database created by the test setup. Never set integration-test configuration to the production database.

Before migration work:
- Inspect the migration runner, pending migration files, `schema_migrations` state and checksums.
- MySQL DDL may not be transactional; a failed migration may have partially applied.
- Do not blindly rerun a partially applied migration.
- Prefer additive versioned migrations and a reviewed forward-fix.
- Never use `CREATE TABLE IF NOT EXISTS` as a substitute for schema evolution.
- Never drop production tables/databases or rewrite production rows without explicit approval and a verified recovery plan.

## 6. Deployment prerequisites

A production deployment requires all of the following:
1. Explicit owner approval for the specific deployment.
2. Target PR merged into `install/resumable-ubuntu-v2`.
3. Exact target commit SHA identified.
4. Current VPS branch, HEAD, working tree, service configuration and DB target inspected.
5. No tracked local modifications or unknown files at risk.
6. Relevant unit and isolated MySQL integration tests pass; skips are reported.
7. CI is green for the exact merged commit.
8. Migration impact and rollback/recovery strategy reviewed.
9. Current backup/recovery state understood for any data/schema-impacting change.
10. A bounded smoke-test plan exists.

If any prerequisite fails, stop; do not improvise a destructive workaround.

## 7. Approved deployment sequence

Only after explicit approval:

1. Capture sanitized pre-deploy state: branch, HEAD, working tree, service status and relevant logs.
2. Confirm target commit is merged into the operational branch.
3. Fetch the exact operational branch, using the explicit refspec above if still needed.
4. Confirm fast-forward relationship; use `git merge --ff-only`. Never force-reset.
5. Inspect lockfile/dependency changes. Do not run `npm ci` blindly, especially if an untracked lockfile exists.
6. Run syntax checks and safe focused tests. Run integration tests only against isolated `_ci`/`_test` DB.
7. Apply only reviewed pending migrations through the documented migration process. Do not manually improvise SQL on production.
8. Restart only the intended service if the approved release requires it.
9. Verify service state, PID/start time, startup logs and database connectivity.
10. Perform a Telegram smoke test with a test account and disposable/draft data.
11. Record actual deployed SHA, migration state, test results, service evidence and Telegram outcome in `PROJECT_ROADMAP.md`; update this file if the runbook/environment changed.

## 8. Restart and post-deploy verification

Restart command — requires explicit approval:

```bash
sudo systemctl restart ustore-telegram-bot.service
```

Verify:

```bash
systemctl is-active ustore-telegram-bot.service
systemctl show --no-pager ustore-telegram-bot.service \
  -p MainPID -p ActiveEnterTimestamp -p ActiveState -p SubState
journalctl -u ustore-telegram-bot.service -n 60 --no-pager
```

Expected startup signals include:
- `Database connection established`
- `Launching Telegram bot with long polling`

Also check for startup exceptions, repeated restarts, DB errors, update-processing failures, rate-limit anomalies and notification-delivery failures. Sanitize logs before sharing.

## 9. Post-deploy Telegram smoke tests

Use test accounts and draft/disposable campaign data:
- /start and registration continuation/cancellation.
- Native contact sharing and ownership validation.
- Customer inline navigation and authorization gates.
- Campaign list/detail and Jalali/Tehran date display.
- Draft campaign date input and UTC round-trip.
- Free entry duplicate prevention and code display (only in a safe test campaign).
- Admin access and role isolation using separate test accounts.
- Payment receipt flow only in isolated test environment; never create a real charge or approve a real participant order as a test.
- Notification delivery/outbox visibility and safe retry warning.
- Support ticket lifecycle and CSV output where in scope.

Do not test by mutating an active campaign, real customer profile, real payment or production participant code.

## 10. Rollback and incident handling

- Prefer a reviewed forward-fix for application defects.
- Do not use `git reset --hard`, force-push, reverse migrations or database restore without explicit approval and a verified plan.
- If the new process fails to start, capture sanitized current Git/service/log state first. Do not repeatedly restart or modify DB blindly.
- If a migration partially applied, inspect exact schema and migration history/checksum before any retry.
- If Telegram polling/webhook state is wrong, inspect current webhook/pending-update behavior and use the documented recovery path; do not delete pending updates casually.
- A rollback of application code does not automatically roll back database schema. Check compatibility before reverting code.
- For data loss or corruption, stop writes if safe, preserve evidence, identify the last verified backup and follow an approved restore plan.

## 11. Documentation and audit trail

Every deployment record must include:
- date/time and operator
- PR and commit SHA
- pre-deploy and post-deploy VPS HEAD
- migration IDs and outcome (no secrets/data dumps)
- unit/integration/CI results, including skipped tests
- service state and sanitized startup evidence
- Telegram smoke-test scenarios and outcomes
- unresolved issues and rollback decision

Update `PROJECT_ROADMAP.md` for deployment status and `PROJECT_CONTEXT.md` if runtime/architecture decisions change. Never treat a GitHub merge or a CI pass as proof of VPS deployment or Telegram runtime health.
