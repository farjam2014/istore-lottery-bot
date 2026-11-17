# Verifiable campaign draw operations

## Encryption key

`DRAW_SEED_ENCRYPTION_KEY` must be a cryptographically random 32-byte value encoded as 64 hexadecimal characters. Generate it with a trusted cryptographic random generator, store it in the production secret manager or a root-readable environment file, and never commit it, print it in logs, or send it through Telegram.

Keep an encrypted, access-controlled backup of the exact key. Losing it while a draw is in `prepared` state makes the stored seed ciphertext unrecoverable and prevents completion of that draw. The seed commitment remains visible, but it cannot reconstruct the seed.

## Rotation

The current schema does not store a key identifier and the service expects one active key. Therefore, do not rotate the key while any draw is in `prepared` state. Before rotation:

1. Confirm there are no `campaign_draws` rows with `status='prepared'`.
2. Back up the database and the current key securely.
3. Change the key through the production secret-management process.
4. Verify a controlled test draw in a disposable database using the new key.

If a prepared draw exists, retain the old key until that draw is completed or implement and test a key-versioned re-encryption migration. Do not overwrite the only copy of the old key.

## Draw procedure

1. Close the campaign and verify its eligible entries and active codes.
2. Prepare the draw. Record and publish the SHA-256 seed commitment and candidate snapshot hash before execution.
3. Complete the draw only after reviewing those published commitments.
4. Publish the revealed seed and winner result.
5. Verify the result independently using the candidate snapshot, seed, commitment, and winner rows.

The service refuses completion if a candidate's stored snapshot integrity fails or its current code, entry, or participant eligibility has changed since preparation.

## Operational boundary

The migration adding verifiable draw columns is versioned and must be reviewed and backed up before production application. A green CI run does not apply migrations or deploy code. Never run integration tests against a production database.
