# Verifiable campaign draw operations

## Encryption key

Draw seed encryption uses AES-256-GCM with a 32-byte cryptographically random key. The preferred configuration is the versioned keyring (`DRAW_SEED_ENCRYPTION_KEYS` plus `DRAW_SEED_ACTIVE_KEY_ID`); `DRAW_SEED_ENCRYPTION_KEY` remains supported as the legacy `legacy-env` key. Store key material in a production secret manager or a root-readable environment file, and never commit it, print it in logs, or send it through Telegram.

Keep an encrypted, access-controlled backup of every configured key. Losing the key referenced by a draw in `prepared` state makes its stored seed ciphertext unrecoverable and prevents completion of that draw. The seed commitment remains visible, but it cannot reconstruct the seed.

## Keyring and rotation

New draws store the selected key ID in `campaign_draws.seed_key_id`. The migration assigns existing rows the ID `legacy-env`. This preserves compatibility only when a row already contains valid seed ciphertext, nonce, and authentication tag encrypted with `DRAW_SEED_ENCRYPTION_KEY`; assigning a key ID does not reconstruct missing ciphertext or recover a seed from its hash. Rows with NULL encryption fields, or a prepared draw using an unsupported historical algorithm, remain blocked and must not be automatically re-prepared. Inventory these rows before applying migrations or rotating keys, and agree on a manual recovery decision for each one.

Preferred configuration:

- `DRAW_SEED_ENCRYPTION_KEYS`: JSON object mapping stable key IDs to 64-character hexadecimal keys (32 random bytes each).
- `DRAW_SEED_ACTIVE_KEY_ID`: ID used for newly prepared draws.
- `DRAW_SEED_ENCRYPTION_KEY`: legacy fallback for the `legacy-env` key. Keep it configured while any prepared draw references that ID.

Generate each key with a cryptographically secure random generator, for example `openssl rand -hex 32`. Do not reuse a key ID for different key material. Do not put real key values in source control, tickets, logs, Telegram, or proof files.

Safe rotation procedure:

1. Back up the database and all currently configured draw keys using separate, access-controlled, encrypted backup paths. Record the key IDs in the backup inventory.
2. Add a new key ID and key value to `DRAW_SEED_ENCRYPTION_KEYS`, while retaining every old key ID still referenced by a prepared draw.
3. Set `DRAW_SEED_ACTIVE_KEY_ID` to the new ID. New draws will use it; existing prepared draws continue to decrypt with their stored `seed_key_id`.
4. Validate the new key and old-key compatibility in a disposable database using the same keyring configuration. Verify a draw encrypted with the old key can still be decrypted after rotation, and a newly prepared draw uses the new ID.
5. Deploy the configuration through the approved secret-management process only after backup and restore checks. Do not edit production environment files or restart production as part of this development change.
6. Retire an old key only after a read-only production inventory confirms no prepared draw references it, and the recovery/backup retention policy no longer requires it. Keep a recoverable encrypted archive for the required retention period.

If a key is missing, the service fails closed and refuses to complete the affected draw. Never replace a missing historical key with a new value under the same key ID. Losing the key for a prepared draw makes its seed unrecoverable.

The integration test performs a real `mysqldump` and MySQL restore into a separate disposable database. Its keyring recovery and rotation portion uses in-memory fixture keys; it does not prove restoration from the production Secret Manager or an independent key-backup vault. That recovery drill remains a separate release prerequisite.

## Ranking algorithm

The current algorithm is `HMAC-SHA256 candidate-commitment-rank-v2`. Each candidate is ranked using its committed `candidate_hash`, not the mutable database row ID. The verifier requires the declared algorithm version, validates unique candidate and code identifiers, checks contiguous winner ranks, and recomputes the winner selection. Prepared draws created with a different algorithm version are rejected by the completion service and must not be silently executed under a new version.

## Draw procedure

1. Close the campaign and verify its eligible entries and active codes.
2. Prepare the draw. Record and publish the SHA-256 seed commitment and candidate snapshot hash before execution.
3. Submit the public HTTPS publication URL in the admin workflow and explicitly confirm it. The service records the URL, timestamp, and admin ID and blocks completion until this record exists. This is an auditable admin attestation, not independent verification that the URL is public or that it contains the correct values.
4. Complete the draw only after reviewing those published commitments.
5. Publish the revealed seed and winner result.
6. Verify the result independently using the candidate snapshot, seed, commitment, and winner rows.

The service refuses completion if a candidate's stored snapshot integrity fails or its current code, entry, or participant eligibility has changed since preparation.

## Operational boundary

The campaign-code migration assigns legacy codes stable per-campaign sequence numbers in original code-ID order, keeps them at format version 1, and seeds each counter to the highest migrated sequence. Campaigns with more than 999999 legacy codes are rejected before migration. The draw-publication migration adds the publication reference and audit fields. Migration 006 adds database-enforced candidate/entry/participant/code ownership and exact winner-to-candidate identity. It refuses to run when legacy draw candidate or winner rows exist; those records must be explicitly reconciled rather than assigned inferred snapshots. These migrations are versioned and must be reviewed and backed up before production application. A green CI run does not apply migrations or deploy code. Never run integration tests against a production database.


## Offline proof artifact (version 1)

After a draw is completed, an administrator with `campaign.draw` can download a gzip-compressed JSON proof from the draw result screen. The artifact contains the draw ID and campaign ID, algorithm version, revealed seed, seed commitment, candidate snapshot hash, every committed candidate record, winner records, and the recorded publication attestation. It excludes participant names, phone numbers, Instagram handles, Telegram IDs, and the publishing administrator's Telegram ID; the publisher is represented only as `admin`. Numeric internal participant IDs are included because the verifier needs to check that winners are unique participants; treat the file as an internal identifier-bearing record, not as anonymous data.

On a machine with Node.js 22 and the repository source:

```sh
gunzip -c campaign-draw-<id>-proof.json.gz > proof.json
npm run verify:draw-proof -- proof.json
```

The verifier is pure local code: it reads only the JSON file and does not connect to MySQL, Telegram, environment variables, or the seed-encryption key. Exit code 0 means the proof is internally consistent with the published seed commitment and snapshot hash; exit code 1 means verification failed; exit code 2 means the CLI usage is invalid.

The proof verifier checks the supported algorithm, seed commitment, candidate record hashes, candidate snapshot hash, candidate/winner counts, unique candidate/code identifiers, contiguous winner ranks, unique participant winners, and deterministic winner selection. Keep the original downloaded artifact unchanged and retain its SHA-256 digest separately when archiving or sharing it.

Important limitations:
- A valid proof demonstrates that the exported candidate list and winners are consistent with the committed snapshot and revealed seed. It does **not** independently prove that every person who should have been eligible was included, or that excluded/ineligible people were correctly filtered. That requires a separately published eligibility register and independent reconciliation against the campaign rules and source records.
- The publication URL and timestamp in the proof are admin self-attestation. The input validator requires HTTPS and rejects IP literals and common special-use/internal host suffixes, but it does not perform DNS or network reachability checks. The verifier does not fetch the URL, prove it was public at the stated time, or prove that its content was not changed later.
- The proof contains internal numeric participant IDs. Do not publish it broadly without assessing the privacy implications and applicable campaign rules.
- Telegram delivery is gzip-compressed and capped at 45 MiB. Larger proofs currently fail closed; chunked export is not implemented.
