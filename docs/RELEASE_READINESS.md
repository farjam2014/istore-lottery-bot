# Release readiness and rollback procedure

## Release status

This document is an operational checklist, not an authorization to deploy. A release is blocked until the production inventory, historical draw/key inventory, independent key backup, and restore rehearsal are verified. Do not merge, deploy, restart the service, or run production migrations without separate approval.

Target runtime: Ubuntu 24.04, Node.js 22+, MySQL 8+, systemd service `ustore-telegram-bot.service`. The application directory and service configuration must be confirmed on the target host before use.

## 1. Pre-deployment gates

- [ ] Confirm the exact GitHub PR head SHA and base SHA; confirm the latest CI run is successful on that exact head.
- [ ] Review the full PR diff and migration files; do not rely on `mergeable=true` alone.
- [ ] Confirm the target host, application directory, systemd unit, Node version, MySQL version, and database name.
- [ ] Confirm `MYSQL_DATABASE` and `MYSQL_USER` match the installer's accepted generated-name pattern. If the existing production database/user uses a legacy name, stop and design an explicit compatibility path; never rename or recreate it automatically.
- [ ] Confirm a clean, known code version is deployed and record its commit SHA.
- [ ] Confirm `.env` is a regular file owned by the service account with mode `600`. Never print or upload it.
- [ ] Confirm `BOT_TOKEN`, MySQL credentials, admin IDs, and keyring settings are valid without displaying their values.
- [ ] Confirm the active key ID and every historical key ID referenced by prepared draws are present.
- [ ] Confirm there are no prepared draws with missing ciphertext, nonce, tag, unknown key IDs, or unsupported algorithms.
- [ ] Confirm no legacy campaign-code ownership mismatch and no campaign exceeds the 999999 sequence limit.
- [ ] Confirm no old prepared draw requires manual recovery before applying the draw migrations.
- [ ] Run `scripts/production-migration-preflight.sql` against the exact target database using a read-only MySQL account; retain its output with the release evidence.

## 2. Backup requirements

Before any production schema change:

1. Record the deployed code SHA and current migration history.
2. Create a consistent MySQL backup using the approved backup procedure and a protected destination.
3. Encrypt the backup at rest and restrict access to the minimum required operators.
4. Record backup timestamp, database name, file size, checksum, and retention location.
5. Restore the backup into a separate disposable database and verify key application tables and row counts.
6. Back up all draw seed key material independently of the database backup. Preserve the exact key IDs and their mapping to key material in an access-controlled encrypted vault.
7. Perform a recovery rehearsal proving that the restored database and independently restored keyring can decrypt a prepared draw.
8. Do not proceed if any backup, restore, key custody, or decryption check fails.

A database dump alone is not a complete backup for prepared draws. Losing the historical key referenced by a prepared draw makes its encrypted seed unrecoverable.

## 3. Migration order and behavior

The migration runner sorts SQL files by filename. The six new migrations are applied in this order:

1. `20261117_001_campaign_code_sequence.sql` — adds per-campaign sequence metadata and counters, preserves existing codes as format version 1, and seeds counters in original code-ID order.
2. `20261117_002_admin_campaign_code_search.sql` — adds campaign-scoped admin code search.
3. `20261117_003_verifiable_campaign_draws.sql` — adds draw snapshot, participant, candidate, winner, and seed fields and constraints.
4. `20261117_004_draw_commitment_publication.sql` — adds publication attestation fields and admin workflow states.
5. `20261117_005_draw_seed_keyring.sql` — adds `seed_key_id`, defaulting existing rows to `legacy-env`.
6. `20261117_006_draw_relational_integrity.sql` — binds each candidate to its exact campaign entry, participant, and code; binds each winner to the exact candidate identity; rejects incomplete or mismatched identity rows.

Important migration properties:

- MySQL DDL auto-commits; the migration batch is not transactionally reversible.
- The runner has replay guards for selected partial-DDL states. A guard does not make every possible schema state safe to replay.
- Applied migration checksums must not change.
- Migration 001 now checks for legacy campaign-code rows whose `campaign_id` disagrees with their entry's campaign before adding the composite foreign key.
- Migration 006 fails closed if any legacy `draw_candidates` or `draw_winners` rows exist. It does not infer historical candidate snapshots or participant ownership. Existing draw evidence must be reviewed and reconciled explicitly before this migration can be applied.
- Assigning `legacy-env` does not create missing ciphertext. A legacy prepared draw without ciphertext/nonce/tag cannot be recovered from its seed hash.
- Never automatically cancel, re-prepare, or replace a prepared draw to work around a missing key or unsupported algorithm.

Run production migrations only after explicit approval, a verified backup, and a read-only inventory. The migration guard requires both `ALLOW_DATABASE_MIGRATIONS=1` and `ALLOW_PRODUCTION_MIGRATIONS=1`, with `MIGRATION_TARGET_DATABASE` exactly matching `MYSQL_DATABASE`.

## 4. Deployment sequence

1. Confirm all pre-deployment gates and record the current code SHA.
2. Put registration and payment review into an approved maintenance window; prevent new business writes while taking the final backup and applying migrations.
3. Verify the backup and independent key backup before proceeding.
4. Update to the approved release commit using the reviewed deployment method. Do not use an unreviewed installer branch or a floating branch name as the release identity.
5. Install production dependencies with the repository's supported Node.js version.
6. Run the approved migration command once against the exact target database.
7. If a migration fails, stop. Capture the error and inspect `schema_migrations` plus `information_schema`; do not blindly rerun or manually drop objects.
8. Verify migration checksums and the expected schema before enabling application traffic.
9. Start or restart the systemd service only after separate deployment approval.
10. Observe logs and service health before re-enabling registration and payment workflows.

The Ubuntu installer does not create a database backup. Its approval flags authorize schema/database changes; they do not replace backup verification or production approval.
The installer validates the environment first, then stops an active service before updating the source checkout or applying migrations. If it fails after stopping the service, it deliberately leaves the service stopped; inspect the code and schema state before any manual start.

## 5. Post-deployment checks

Perform these checks first in staging. Production write tests require separate approval and must use clearly identified test records.

- [ ] Service is active and remains stable; no restart loop or fatal startup errors.
- [ ] Telegram polling is active and no stale webhook/update loss is reported.
- [ ] `/start` and the participant profile flow work.
- [ ] Duplicate registration is idempotent and does not return revoked/disqualified codes.
- [ ] New code format, sequence boundaries, per-campaign counter isolation, and database uniqueness are correct.
- [ ] Paid-order creation, receipt submission, approval/rejection, and code issuance work end-to-end.
- [ ] Admin role and permission checks are enforced server-side.
- [ ] Campaign closure blocks new entries and pending payments prevent draw preparation.
- [ ] Concurrent draw preparation/completion produces at most one draw and one winner set.
- [ ] Draw publication gate blocks completion until an HTTPS attestation is recorded.
- [ ] Proof export succeeds, contains no participant contact details or Telegram IDs, and stays within the 45 MiB compressed limit.
- [ ] Offline proof verification succeeds on a separate machine.
- [ ] Notification outbox, audit logs, and error rates are healthy.
- [ ] Backup and key recovery remain available after the deployment.

## 6. Stop conditions

Stop the release and keep the system in its safest available state if any of the following occurs:

- Latest-head CI is missing or failing.
- Backup or restore verification fails.
- Any prepared draw references a missing key or lacks decryptable ciphertext.
- A migration detects partial or mismatched schema/data.
- Legacy code ownership mismatches or sequence capacity overflow are found.
- An unsupported prepared-draw algorithm is present.
- A critical/high permission, privacy, race, or data-integrity issue remains.
- The rollback path would require discarding writes made after the backup.

## 7. Rollback and recovery

There are no general-purpose down migrations for this release. Do not attempt to reverse the SQL changes by dropping columns, indexes, or tables.

### If failure occurs before application traffic is enabled

1. Keep the service stopped.
2. Preserve the failed deployment logs and current schema/migration inventory.
3. Restore the pre-deployment database backup using the approved recovery procedure.
4. Restore the matching historical draw keyring from its independent encrypted backup.
5. Restore the previously recorded application commit and dependency lock state.
6. Verify prepared-draw decryption and core table counts before starting the previous version.

### If the new version has already accepted writes

Do not restore the pre-deployment database backup blindly: doing so would discard registrations, payments, audit records, or draw state created after that backup.

- Keep the service in maintenance/stop state if necessary.
- Prefer a forward fix that preserves the new schema and all post-deployment writes.
- If code rollback is unavoidable, first prove the old code is compatible with the migrated schema and understand how it affects code issuance counters. The older code path may not update the new per-campaign counters.
- Reconcile every post-backup write before considering a database restore.

### Draw/key recovery

- Restore the database and the exact key material referenced by each prepared draw.
- Verify key IDs without printing key values.
- Decrypt a prepared draw and compare the resulting seed hash to its stored commitment.
- If the historical key is unavailable or the ciphertext is missing/corrupt, stop that draw. Do not generate a replacement seed or silently re-prepare it.

## 8. Known proof limitations

- Publication URL and timestamp are admin self-attestation; the verifier does not fetch the URL or independently prove publication timing/content.
- The proof validates the committed candidate set and deterministic winner selection, not completeness of eligibility. An independently published eligibility register and reconciliation are still needed.
- Proof artifacts contain internal numeric participant IDs; they are not anonymous.
- Compressed Telegram export is capped at 45 MiB; chunked export is not implemented.
- The CI backup/restore test performs a real database dump and restore, but its keyring portion uses fixture keys. It does not prove restoration from the production Secret Manager or independent key vault.

## 9. Release decision

Do not label the release READY until the latest-head CI, production read-only inventory, independent key backup/recovery rehearsal, migration compatibility, and rollback plan have all been verified with evidence. Any unverified production condition remains BLOCKED or NOT VERIFIED.
