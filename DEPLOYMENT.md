# UStore Telegram Bot — Deployment and Operations

> Operational notes for the known VPS deployment. Confirm live values before every deployment; this document is not a secret store or live monitoring system.

## Known deployment (operator-confirmed snapshot: 2026-11-15)

- OS: Ubuntu 24.04.5 LTS
- Repository: `farjam2014/istore-lottery-bot`
- Checkout: `/opt/ustore-telegram-bot`
- Operational branch: `install/resumable-ubuntu-v2`
- systemd unit: `ustore-telegram-bot.service`
- Service user: `ustorebot`
- Working directory: `/opt/ustore-telegram-bot`
- ExecStart: `/usr/bin/node /opt/ustore-telegram-bot/src/index.js`
- Runtime: Node.js 22.x
- Database: MySQL 8.0.x; database name is configured through `MYSQL_DATABASE` in the server environment.
- Last deployed commit recorded: `ee2a85cfd886145547310ec845fff68036fd4ea2`.
- After restart, operator output showed service `active/running`, PID `172804`, `Database connection established`, and `Launching Telegram bot with long polling`.

Do not assume the PID, service state, installed dependencies, branch head or database state remains unchanged.

## Important safety boundaries

- The assistant does not have implicit SSH access. The server operator runs commands and shares sanitized output.
- Never print `.env`, `BOT_TOKEN`, `MYSQL_PASSWORD`, private keys or full payment-card data.
- Do not run `install.sh`, database reset, `DROP DATABASE`, `DROP TABLE`, production integration tests or OS release upgrades as part of routine deployment.
- Do not run `npm run test:integration` against the production database.
- The integration suite can mutate schema and rows. Use only a disposable MySQL database ending in `_ci` or `_test`.
- Do not reboot the VPS merely because Ubuntu reports that a restart is required.
- Production restart/deploy requires explicit owner approval.

## Read-only preflight commands

Run from an SSH session:

```bash
cd /opt/ustore-telegram-bot
git status --short --branch
git branch --show-current
git rev-parse HEAD
git remote -v
```

Inspect the service without exposing secrets:

```bash
SYSTEMD_PAGER=cat systemctl show --no-pager ustore-telegram-bot.service \
  -p User -p WorkingDirectory -p ExecStart -p EnvironmentFiles \
  -p MainPID -p ActiveState -p SubState
```

Show only whether the DB name is configured, never the full environment:

```bash
grep -E '^MYSQL_DATABASE=' .env | sed 's/=.*/=<configured>/'
```

Check installed dependency tree without reinstalling:

```bash
npm ls --depth=0
```

## Known Git fetch refspec issue

During the 2026-11-15 deployment, `remote.origin.fetch` was configured only for a different branch, so a normal `git fetch origin` did not update the tracking ref for `install/resumable-ubuntu-v2`.

The explicit fetch used successfully was:

```bash
git fetch origin +refs/heads/install/resumable-ubuntu-v2:refs/remotes/origin/install/resumable-ubuntu-v2
```

Then the fast-forward update was:

```bash
git merge --ff-only origin/install/resumable-ubuntu-v2
```

Before repeating this, inspect the current branch, working tree, remote and remote branch head. Never force-reset or overwrite local work to make deployment easier.

At that time, `.lesshst`, `.npm/` and an untracked `package-lock.json` were present. They were intentionally left untouched. If they are still present, do not delete or overwrite them without inspecting their purpose and ownership.

## Test policy

Safe production-local checks previously used:

```bash
node --test tests/datetime.test.js
npm test
```

At the 2026-11-15 deployment snapshot:
- Date/time tests: 4 passed, 0 failed.
- `npm test`: 38 passed, 0 failed, 18 skipped.
- The 18 skipped tests were MySQL integration tests; they were not run against production.

GitHub Actions for PR #13 ran all 56 tests successfully, including the MySQL integration tests in CI. Prefer CI or a disposable test database for integration coverage.

## Approved deployment sequence

Only after the owner explicitly approves deployment:

1. Inspect working tree and branch; stop if tracked local modifications or unexpected files could be overwritten.
2. Confirm target commit/PR is merged into the operational branch.
3. Fetch the exact operational branch (account for the refspec issue above).
4. Fast-forward only; do not force-reset.
5. Confirm dependencies are already compatible. Do not run `npm ci` blindly when an untracked lockfile is present; inspect first.
6. Run syntax checks and safe tests.
7. Confirm service unit configuration and working directory.
8. Restart only the intended service.
9. Verify service state, process start time, logs and database connectivity.
10. Perform a Telegram smoke test and update `PROJECT_ROADMAP.md`.

## Restart and post-deploy verification

Restart command (requires explicit approval):

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

Check for startup exceptions, repeated restarts, database errors and notification-delivery failures. Sanitize logs before sharing; do not share tokens, passwords or sensitive participant/payment data.

## Date/time smoke test after PR #13

Use only a draft/disposable campaign and test data:

1. Open campaign list/details and confirm Jalali date display.
2. Confirm displayed time is Tehran time in 24-hour format.
3. Enter a valid Jalali date/time and verify the saved/displayed round-trip.
4. Try an invalid Jalali date and invalid start/end/draw ordering; verify safe rejection.
5. Inspect timestamps in order, receipt, participant history, support and admin messages where available.
6. Inspect CSV date columns if present.

Do not mutate an active campaign, submit a real payment or issue real participant codes as a test.

## Rollback and recovery

- Prefer a reviewed forward-fix for application defects.
- Do not use `git reset --hard`, force-push, database restore or reverse migrations without explicit approval and a verified recovery plan.
- If the new process fails to start, capture sanitized logs and current Git/service state first. Do not repeatedly restart or modify the database blindly.
- Database migrations may include non-transactional DDL. Inspect `schema_migrations` and migration checksums before retrying a partially applied migration.
