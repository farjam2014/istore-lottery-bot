# Production staged deployment runbook

This procedure is for the existing release-directory production host. A read-only audit on 2026-11-27 observed the active release at:

`/opt/ustore-releases/e951f43d6957fffd3262a9e9d400d20e3d31c35e`

This is an audit-time observation, not a permanent deployment target. Immediately before any maintenance window, independently re-confirm the systemd `WorkingDirectory`, `ExecStart`, and `/proc/<MainPID>/cwd` read-only. Never assume this path remains active.

It is a **manual, approval-gated deployment plan**. It has not been executed. Use the exact reviewed and merged release commit SHA, never a floating branch.

## Safety rules

- Do not run the installer against the current host.
- Do not print, upload, or paste `.env`, Telegram bot token, MySQL password, or draw encryption keys.
- Never run two long-polling processes with the same bot token.
- Do not apply migrations before a verified database backup and independent draw-key backup.
- If a migration fails, stop and inspect; do not blindly rerun or manually drop objects.
- Keep the old release directory intact until acceptance is complete.
- A code rollback after migrations is not automatically safe. Verify schema compatibility first.

## 1. Record the current target (read-only)

```bash
sudo systemctl show ustore-telegram-bot.service \
  -p ActiveState -p SubState -p User -p ExecStart -p WorkingDirectory

ACTIVE="$(sudo systemctl show ustore-telegram-bot.service -p WorkingDirectory --value)"
printf 'Active release path: %s\n' "$ACTIVE"
sudo test -f "$ACTIVE/.env"
sudo stat -c '%U %a %n' "$ACTIVE/.env"
```

Record the active path, unit file, service state, and exact database migration history. Do not display environment values.

## 2. Create protected backups

Choose a timestamped backup directory on a protected filesystem:

```bash
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/ustore-release-backup-$STAMP"
sudo install -d -m 700 "$BACKUP_DIR"
```

Obtain `MYSQL_DATABASE` from the protected environment without printing the rest of `.env`. Run the approved consistent dump command for that database, compress it, verify the archive, and record its SHA-256. Keep a copy off-host encrypted.

Back up the exact draw-key configuration/key IDs independently in an access-controlled encrypted vault. Preserve the current `.env` as a root-only recovery artifact, encrypted before off-host storage. A database dump without the historical draw keys is not a complete draw recovery backup.

Restore the backup into a separate disposable database and verify table counts and the prepared-draw/key decryption check before proceeding.

## 3. Stage the exact release

Set `TARGET_SHA` to the exact merged release commit and `TARGET_RELEASE` to a new directory under `/opt/ustore-releases`. Do not reuse or overwrite the active release.

- Clone/fetch the repository at `TARGET_SHA`.
- Copy the protected `.env` from the active release into the new release.
- Set owner to `ustorebot:ustorebot` and mode `600` on `.env`.
- Install locked production dependencies with `npm ci --omit=dev`.
- Run the non-production test suite and JavaScript syntax checks from the staged directory. Do not set `RUN_MYSQL_TESTS=1` against the production database.
- Record the target SHA and the staged file inventory.

## 4. Read-only production preflight

Run `scripts/production-migration-preflight.sql` from the staged release against the exact production database using a read-only account. Retain the output.

Stop release preparation if it reports any of the following:

- code/entry campaign ownership mismatches;
- sequence overflow;
- existing draw candidates or winners that block migration 006;
- prepared draws with unresolved key/ciphertext/algorithm state;
- unexpected migration history or missing required schema;
- migration checksum disagreement.

Reconcile the exact target database and key inventory before any write.

## 5. Approved maintenance window

Only after separate approval:

1. Announce maintenance and prevent new registration/payment writes.
2. Stop the active service and confirm it is stopped. Do not start the staged release yet.
3. Run `npm run db:migrate` from the staged release with all three explicit target-bound authorization variables:
   `ALLOW_DATABASE_MIGRATIONS=1`,
   `ALLOW_PRODUCTION_MIGRATIONS=1`, and
   `MIGRATION_TARGET_DATABASE=<exact MYSQL_DATABASE>`.
4. Capture migration output and verify `schema_migrations` checksums and expected schema.
5. If migration fails, keep the service stopped and follow the failure/restore decision tree. Never automatically restore a backup after new writes have occurred.

## 6. Point systemd at the staged release

Back up the existing unit file and create a systemd drop-in that sets the staged release's:

- `WorkingDirectory`
- `ExecStart` (clear the previous ExecStart first)
- `ReadWritePaths` (clear the previous path list, then set the new release path)

Then run `systemctl daemon-reload`, start the service, and confirm:

- `ActiveState=active`, `SubState=running`, nonzero `MainPID`;
- journal contains `Telegram bot launched with long polling`;
- no restart loop, fatal startup error, migration error, or Telegram polling conflict.

Do not start the old and new releases simultaneously.

## 7. Smoke test and acceptance

Run read-only/low-impact checks first:

- `/start` and participant menu;
- super-admin `/admin` access and system-health view;
- campaign list/details;
- outbox and Telegram inbox status/retry visibility;
- service logs and MySQL connectivity.

Do not create a real payment, issue production codes, close a campaign, prepare/complete a draw, or export personal data as a smoke test without explicit test-data and production-write approval.

Complete the remaining fresh-server acceptance and backup/key recovery rehearsal on a disposable environment. Production launch is blocked until every P0/P1 finding is closed and the evidence is recorded.

## 8. Rollback

- Before migrations: restore the previous unit path and start the old release.
- After migrations but before traffic: do not assume old code is compatible. Prefer a forward fix. Restoring the database is allowed only after a verified backup/key restore and a decision that no post-backup writes will be lost.
- After the new version accepts writes: never restore the pre-deployment database blindly. Preserve all new writes and prefer a forward fix. Code rollback requires a compatibility review of the migrated schema and code-issued sequence counters.

This runbook does not authorize deployment, migration, service restart, or production writes.
