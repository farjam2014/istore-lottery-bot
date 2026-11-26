# Release readiness and rollback procedure

## Release status

This document is an operational checklist, not an authorization to deploy. A release is blocked until the production inventory, historical draw/key inventory, independent key backup, and restore rehearsal are verified. Do not merge, deploy, restart the service, or run production migrations without separate approval.

Target runtime: Ubuntu 24.04, Node.js 22+, MySQL 8+, systemd service `ustore-telegram-bot.service`. The application directory and service configuration must be confirmed on the target host before use.

For the existing release-directory deployment, follow [`PRODUCTION_STAGED_DEPLOYMENT.md`](./PRODUCTION_STAGED_DEPLOYMENT.md). Do not use the Ubuntu installer to deploy over the active release path.

## 1. Pre-deployment gates

- [ ] Confirm the exact GitHub PR head SHA and base SHA; confirm the latest CI run is successful on that exact head.
- [ ] Review the full PR diff and migration files; do not rely on `mergeable=true` alone.
- [ ] Confirm the target host, application directory, systemd unit, Node version, MySQL version, and database name.
- [ ] Confirm `MYSQL_DATABASE` and runtime `MYSQL_USER` match the installer's accepted generated-name pattern. If the existing production database/user uses a legacy name, stop and design an explicit compatibility path; never rename or recreate it automatically.
- [ ] Confirm the runtime database account has only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the application database; DDL must use a separate migration account.
- [ ] Confirm a clean, known code version is deployed and record its commit SHA.
- [ ] Confirm `.env` is a regular file owned by the service account with mode `600`. Never print or upload it.
- [ ] Set `PRIVACY_NOTICE_URL` to the published HTTPS notice and `PRIVACY_NOTICE_VERSION` to its reviewed version; verify the URL is reachable and the bot records acceptance before collecting participant data.
- [ ] Confirm `BOT_TOKEN`, MySQL credentials, admin IDs, and keyring settings are valid without displaying their values.
- [ ] Confirm the active key ID and every historical key ID referenced by prepared draws are present.
- [ ] Confirm every historical draw key ID is accounted for in the protected keyring backup; do not infer ciphertext decryptability from the baseline preflight alone.
- [ ] Confirm no legacy campaign-code ownership mismatch and no campaign exceeds the 999999 sequence limit.
- [ ] Confirm no old prepared draw requires manual recovery before applying the draw migrations.
- [ ] Run `scripts/production-migration-preflight.sql` against the exact target database using a read-only MySQL account; retain its output with the release evidence.
- [ ] Run `bash scripts/production-host-preflight.sh` as root from the staged release; retain its sanitized host/grant/runner/backup output privately and close every reported blocker.
- [ ] Review exact row counts for all six replay-cleanup tables and both retained-but-cursorless search-session tables, plus the support-session step breakdown; approve any non-zero impact and the customer/support handling plan.
- [ ] Re-run the complete read-only SQL preflight after the service is stopped and immediately before the migration runner; compare it with the earlier baseline.

## 2. Backup requirements

Before any production schema change:

1. Record the deployed code SHA and current migration history.
2. Create a consistent MySQL backup using the approved backup procedure and a protected destination.
3. Encrypt the backup at rest and restrict access to the minimum required operators.
4. Record backup timestamp, database name, file size, checksum, and retention location.
5. Restore the backup into a separate disposable database and verify key application tables and row counts.
6. Back up all draw seed key material independently of the database backup. Preserve the exact key IDs and their mapping to key material in an access-controlled encrypted vault.
7. Perform a recovery rehearsal proving that the restored database and independently restored keyring can decrypt a prepared draw.
8. Verify automated database backups are scheduled, the last successful run is recorded, retention and alerting are configured, and the backup is encrypted at rest; gzip compression alone is not encryption.
9. Confirm no plaintext draw-seed key copies remain in backup locations after the encrypted keyring backup and restore rehearsal are verified.
10. Do not proceed if any backup, restore, key custody, or decryption check fails.

A database dump alone is not a complete backup for prepared draws. Losing the historical key referenced by a prepared draw makes its encrypted seed unrecoverable.

## 3. Migration order and behavior

The migration runner sorts SQL files lexicographically by filename. The current source contains 28 migrations, applied in this order:

1. `20261114_001_payment_expiry_reference.sql` — removes the one-order-per-entry restriction, adds unique payment references, expiry metadata, and outbox delivery metadata.
2. `20261114_002_campaign_details.sql` — adds campaign poster, prize, draw, terms, and payment-method fields and expands the campaign wizard.
3. `20261114_003_support_tickets.sql` — creates support tickets, messages, and support-session state.
4. `20261114_004_admin_roles.sql` — creates role-based admin access and role-event history.
5. `20261114_005_payment_admin_sessions.sql` — adds payment administration search/review sessions.
6. `20261114_006_admin_search_and_rate_limits.sql` — adds admin search state and persistent per-user rate-limit buckets.
7. `20261114_007_profile_change_sessions.sql` — adds profile-change sessions and requests.
8. `20261114_008_outbox_uncertain_delivery.sql` — adds notification lease metadata and the `uncertain` delivery state.
9. `20261115-payment-bank-cards.sql` — creates multi-card bank destination management.
10. `20261115_009_correlation_and_delivery_history.sql` — adds correlation IDs and delivery-attempt metadata to audit, payment, update, and outbox records.
11. `20261117_001_campaign_code_sequence.sql` — adds per-campaign sequence metadata and counters, preserves existing codes as format version 1, and seeds counters in original code-ID order.
12. `20261117_002_admin_campaign_code_search.sql` — adds campaign-scoped admin code search.
13. `20261117_003_verifiable_campaign_draws.sql` — adds draw snapshot, participant, candidate, winner, and seed fields and constraints.
14. `20261117_004_draw_commitment_publication.sql` — adds publication attestation fields and admin workflow states.
15. `20261117_005_draw_seed_keyring.sql` — adds `seed_key_id`, defaulting existing rows to `legacy-env`.
16. `20261117_006_draw_relational_integrity.sql` — binds each candidate to its exact campaign entry, participant, and code; binds each winner to the exact candidate identity; rejects incomplete or mismatched identity rows.
17. `20261118_001_participant_search_state.sql` — preserves participant search query state for pagination.
18. `20261118_002_paid_code_quantity.sql` — adds the requested code quantity snapshot to payment orders and performs guarded legacy backfills.
19. `20261119_001_campaign_edit_wizard_step.sql` — appends `campaign_edit_value` to `admin_wizards.step`.
20. `20261119_002_telegram_update_inbox.sql` — creates the durable Telegram update inbox with status, attempt, availability, lease, and error metadata.
21. `20261124_001_admin_action_idempotency.sql` — adds durable idempotency records for replay-safe admin campaign-copy callbacks.
22. `20261124_002_privacy_consent.sql` — adds participant privacy notice version and acceptance timestamp; existing profiles remain unconsented until they accept the published notice.
23. `20261124_003_registration_session_replay.sql` — records the Telegram update ID that advanced a registration text/contact or payment-receipt session, prevents out-of-order cursor regression, and clears pre-cursor registration and pending receipt-upload sessions during the schema transition.
24. `20261124_004_admin_wizard_replay.sql` — records Telegram update IDs for admin campaign, payment-card, and admin-role wizards, preventing stale message replays from being interpreted as input for a later step; clears all pre-cursor admin campaign, payment-card, and admin-role sessions during the schema transition.
25. `20261125_001_support_reply_replay.sql` — clears pending admin support-reply text sessions and adds a Telegram update cursor to support sessions, preventing delayed messages from being consumed by a later reply flow.
26. `20261125_002_admin_search_replay.sql` — adds Telegram update cursors to participant/campaign-code search and payment-order search sessions, rejecting delayed or duplicate search messages.
27. `20261125_003_participant_session_replay.sql` — adds the profile-change session cursor and clears pre-cursor participant support/profile sessions so delayed inbox messages cannot be mistaken for input to a newly started flow.
28. `20261125_004_admin_audit_append_only.sql` — installs database-level BEFORE UPDATE and BEFORE DELETE triggers so the runtime database account cannot alter or erase admin audit evidence.

Important migration properties:

- The application service uses `MYSQL_USER`/`MYSQL_PASSWORD`, restricted to DML on the application database. It must not have `CREATE`, `ALTER`, `INDEX`, or `REFERENCES` privileges. The admin audit table is protected by database triggers that reject UPDATE and DELETE, including attempts made by the runtime DML account.
- Production migrations use `MYSQL_MIGRATION_USER`/`MYSQL_MIGRATION_PASSWORD` with the explicit `TRIGGER` privilege required by the append-only audit migration from `/etc/ustore-telegram-bot/ustore-telegram-bot-migration.env`, owned by root with directory mode `700` and file mode `600`. These credentials must never be copied into the release `.env` or the systemd service environment.
- The migration runner refuses to use the runtime account in production. CI/test environments may reuse their disposable test database account.

- MySQL DDL auto-commits; the migration batch is not transactionally reversible.
- The runner has replay guards for selected partial-DDL states. A guard does not make every possible schema state safe to replay.
- Applied migration checksums must not change.
- Before base-schema or migration DDL, the runner compares every applied migration version with the release source files and fails closed if an applied migration file is missing.
- Migration 009 only extends the `admin_wizards.step` enum. Its replay guard verifies the expected existing workflow values and treats the new value as already applied if it is present; an unexpected enum state fails closed.
- Migration 001 now checks for legacy campaign-code rows whose `campaign_id` disagrees with their entry's campaign before adding the composite foreign key.
- Migration 006 fails closed if any legacy `draw_candidates` or `draw_winners` rows exist. It does not infer historical candidate snapshots or participant ownership. Existing draw evidence must be reviewed and reconciled explicitly before this migration can be applied.
- Assigning `legacy-env` does not create missing ciphertext. A legacy prepared draw without ciphertext/nonce/tag cannot be recovered from its seed hash.
- Never automatically cancel, re-prepare, or replace a prepared draw to work around a missing key or unsupported algorithm.

Run production migrations only after explicit approval, a verified backup, and a read-only inventory. The migration guard requires both `ALLOW_DATABASE_MIGRATIONS=1` and `ALLOW_PRODUCTION_MIGRATIONS=1`, with `MIGRATION_TARGET_DATABASE` exactly matching `MYSQL_DATABASE`. Run the migration process as root (or a dedicated deployment identity with read access to the protected migration file); never grant the migration credentials to `ustorebot`.

## 4. Deployment sequence

1. Confirm all pre-deployment gates and record the current code SHA.
2. Put registration and payment review into an approved maintenance window; prevent new business writes while taking the final backup and applying migrations.
3. Verify the backup and independent key backup before proceeding.
4. Update to the approved release commit using the reviewed deployment method. Do not use an unreviewed installer branch or a floating branch name as the release identity.
5. Install production dependencies with the repository's supported Node.js version.
6. Run the approved migration command once against the exact target database using the protected migration-only credential file; do not inject migration credentials into the service environment.
7. If a migration fails, stop. Capture the error and inspect `schema_migrations` plus `information_schema`; do not blindly rerun or manually drop objects.
8. Run `scripts/post-migration-integrity-check.sql` with a dedicated SELECT-only account after migrations. Confirm no missing/invalid prepared-draw metadata, unsupported algorithms, counter drift, or duplicate code sequences; compare reported key IDs with the protected keyring and restore rehearsal.
9. Verify the runtime database account has only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the target schema, with no global or other-schema grants; keep DDL privileges on the separate protected migration account.
10. Verify migration checksums and the expected schema before enabling application traffic.
11. Start or restart the systemd service only after separate deployment approval.
12. Observe logs and service health before re-enabling registration and payment workflows.

The Ubuntu installer does not create a database backup. Its approval flags authorize schema/database changes; they do not replace backup verification or production approval.
Before using the installer on an existing host, verify that its systemd unit already points to the installer's exact application directory. The installer must refuse mismatched service paths before stopping any service. This installer is not the production release deployment mechanism for the current host, whose active source is under `/opt/ustore-releases/`; use the reviewed staged-release procedure instead.
The installer validates the environment first, then stops an active service before updating the source checkout or applying migrations. If it fails after stopping the service, it deliberately leaves the service stopped; inspect the code and schema state before any manual start.

## 5. Post-deployment checks

Perform these checks first in staging. Production write tests require separate approval and must use clearly identified test records.

- [ ] Service is active and remains stable; no restart loop or fatal startup errors.
- [ ] Telegram polling is active and no stale webhook/update loss is reported.
- [ ] `/start` and the participant profile flow work.
- [ ] Duplicate registration is idempotent and does not return revoked/disqualified codes.
- [ ] New code format, sequence boundaries, per-campaign counter isolation, and database uniqueness are correct.
- [ ] Post-migration integrity SQL returns no missing/invalid draw encryption metadata, unsupported algorithms, code-counter drift, or duplicate sequence values.
- [ ] Paid-order creation, receipt submission, approval/rejection, and code issuance work end-to-end.
- [ ] Admin role and permission checks are enforced server-side.
- [ ] Campaign editing opens the input prompt for every editable field (title, description, prize title/description, terms, start/end/draw dates, capacity, price, and codes per participant); invalid inputs are rejected without changing campaign data, and valid inputs persist and appear in campaign details.
- [ ] Campaign closure blocks new entries and pending payments prevent draw preparation.
- [ ] Concurrent draw preparation/completion produces at most one draw and one winner set.
- [ ] Draw publication gate blocks completion until an HTTPS attestation is recorded.
- [ ] Proof export succeeds, contains no participant contact details or Telegram IDs, and stays within the 45 MiB compressed limit.
- [ ] Offline proof verification succeeds on a separate machine.
- [ ] Notification outbox, audit logs, and error rates are healthy.
- [ ] Telegram inbox backlog, retry/dead-letter counts, and payload-retention cleanup are observable and acceptable.
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

## Privacy and retention

- Participant profiles and payment receipts contain personal data. The application does not currently enforce automatic deletion of participant profiles, payment receipt metadata/file IDs, payment events, or audit logs.
- Before launch, publish a privacy notice and approve retention periods for participant contact data, receipts, payment/order records, support transcripts, and audit logs.
- Verify least-privilege export permissions: participant export requires `participant.export`; campaign code export requires `campaign.read` and `participant.export`; payment export requires `payment.export`. Operational roles must not receive global participant-directory access unless explicitly approved.
- Review Telegram update inbox retention: completed payloads are purged after three days; pending/failed and stale-processing payloads are purged after thirty days.


## 10. External Production gates — not proven by CI

The following items require independent host, account, business, or legal verification. A green GitHub Actions run does not close them.

- [ ] Confirm Public repository visibility is intentional; complete a full-history secret scan and rotate any credential ever committed.
- [ ] Enable branch protection on `main` and `release/ustore-unified`: required PR review, exact CI checks, up-to-date branches, resolved conversations, and no force-push/deletion.
- [ ] Verify no Production self-hosted runner remains registered or online; remove the host-side runner service and any privileged service-management path it could invoke.
- [ ] Verify the Production runtime MySQL account has only DML privileges on the application schema and no global or other-schema grants; provision and protect a separate migration-only account.
- [ ] Verify automated database backups are scheduled, encrypted at rest, access-controlled, retained under an approved schedule, and monitored. Do not treat `.sql.gz` compression as encryption.
- [ ] Verify draw-seed key backups are encrypted, mapped by key ID, independently recoverable, and have no unnecessary plaintext copies.
- [ ] Restore an actual Production backup and the corresponding keyring to an isolated host; decrypt a prepared draw and compare the recovered seed hash to its stored commitment.
- [ ] Publish the reviewed HTTPS privacy notice and set its version; approve retention periods for participants, payment receipts/orders, support messages, Telegram inbox payloads, audit logs, outbox records, exports, and backups.
- [ ] Complete live Telegram private-chat and Telegram Business acceptance tests. If paid campaigns are enabled, test the manual bank-card/receipt review and code-issuance flow end to end; there is no payment gateway in this release.
- [ ] Rehearse the full migration on a restored copy of Production data, including migration 006 legacy-draw guards, failure handling, and forward-fix/restore decision criteria.
- [ ] Do not claim operator-independent randomness: the server operator controls the draw-seed key. The verifier checks the committed candidate set and deterministic selection, not completeness of eligibility or an external randomness beacon.
- [ ] Treat proof artifacts as pseudonymous, not anonymous: they contain internal participant IDs. The verifier does not fetch or authenticate the publication URL. Do not publish raw proof artifacts broadly until privacy/legal approval or a pseudonymization design is in place.
