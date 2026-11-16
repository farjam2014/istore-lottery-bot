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
- Last application-code commit explicitly recorded as deployed remains `ee2a85cfd886145547310ec845fff68036fd4ea2` (PR #13); this is historical and must be rechecked on the VPS.
- GitHub operational branch includes PR #16 (`193602976e1d29c4de5e9d3b1ac4b96a13eee7c3`), PR #17 (`b269c280c1beade14c2ef1d7d56321bc59edbb34`), PR #18 docs refresh (`14c09717bef200aca05193a5416a98bc0107493c`), PR #20 (`8e993c24313ad8c6f3b4b9bea0f135f64e42d0c5`), PR #22 (`d5c5c394e2e486667d93051989210e14900162bb`) PR #24 (`040b5951246cdcd4a14edd74bf7c03d0e2ef7803`) and PR #26 (`9cecaea58647e68831acc8cf35f8b8fba89b7f02`). PR #24 CI run `43873852629` passed 79/79 tests; PR #26 CI run `43875885637` passed 82/82.
- PR #16 adds a new code-format migration that clears approved test participation/payment/draw records. It has **not** been run on the VPS. Do not apply it until read-only table counts confirm that every affected row is disposable test data and the service is stopped under a separately approved deployment.
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
git log -1 --format='%H%n%cI%n%s'
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

Read-only database preflight for the approved campaign-code migration. This reports counts and migration metadata only; it does not modify rows:

```bash
DB_NAME="$(sed -n 's/^MYSQL_DATABASE=//p' .env | head -n1 | tr -d "\"'")"
sudo mysql --batch --skip-column-names "$DB_NAME" -e "
SELECT 'campaigns', COUNT(*) FROM campaigns
UNION ALL SELECT 'participants', COUNT(*) FROM participants
UNION ALL SELECT 'campaign_entries', COUNT(*) FROM campaign_entries
UNION ALL SELECT 'campaign_codes', COUNT(*) FROM campaign_codes
UNION ALL SELECT 'payment_orders', COUNT(*) FROM payment_orders
UNION ALL SELECT 'payment_receipts', COUNT(*) FROM payment_receipts
UNION ALL SELECT 'payment_events', COUNT(*) FROM payment_events
UNION ALL SELECT 'campaign_draws', COUNT(*) FROM campaign_draws
UNION ALL SELECT 'draw_candidates', COUNT(*) FROM draw_candidates
UNION ALL SELECT 'draw_winners', COUNT(*) FROM draw_winners;
"
sudo mysql --batch "$DB_NAME" -e "
SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 8;
SELECT 'sequence_number_column', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_codes' AND COLUMN_NAME='sequence_number';
SELECT 'campaign_code_counters_table', COUNT(*) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_code_counters';
"
unset DB_NAME
```

If the `sudo mysql` socket login fails, share only the error; do not print `.env` or credentials. Do not run the migration as part of this preflight.

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
- PR #16 migration `20261116_001_campaign_code_format.sql` deletes all rows from `draw_candidates`, `draw_winners`, `campaign_draws`, `payment_receipts` and `payment_events` associated with campaign orders, `payment_orders`, `campaign_codes` and `campaign_entries`.
- It preserves campaign definitions (including open campaigns), participant master profiles, bank-card settings, admin records, audit history and notification outbox rows. The per-campaign counter starts at 10001.
- This exact cleanup scope was approved for current test allocations. Approval does not remove the need to inspect actual production counts first. If any affected row represents a real customer/payment/draw record, stop and do not apply the migration.
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
