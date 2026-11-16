# Campaign code format

## Public format for newly issued codes

`P{campaign_id}-{six_character_middle}-{two_character_suffix}`

- `P` means Project.
- The decimal campaign database ID follows `P` (for example, campaign ID 13 becomes `P13`).
- The middle segment is exactly six characters.
- The final suffix is exactly two characters.
- All generated letters are uppercase.

Existing issued codes are historical identifiers and remain unchanged by the migration. The new format applies to codes issued after the migration.

## Middle segment

The ticket sequence is stored as an integer and rendered without truncation at the right edge of the six-character middle segment. Random characters fill the remaining positions on the left.

| Sequence digit count | Random prefix length | Sequence digits |
| --- | ---: | ---: |
| 1 | 5 | 1 |
| 2 | 4 | 2 |
| 3 | 3 | 3 |
| 4 | 2 | 4 |
| 5 | 1 | 5 |
| 6 | 0 | 6 |

New-format code allocation starts at sequence 10001 for each campaign, or at the next number after a higher sequence already exists. The maximum supported sequence is 999999.

## Random-character rule

Random positions use `ABCDEFGHJKLMNPQRSTUVWXYZ0123456789` (ambiguous I and O are excluded). The final character of each random segment is restricted to `ABCDEFGHJKLMNPQRSTUVWXYZ0`.

There are two random segments:
1. The random prefix before the sequence in the middle segment. If its length is non-zero, its last character must be a letter or `0`.
2. The two-character suffix. Its first character may use the full random alphabet; its second character must be a letter or `0`.

The restriction applies only to the last character of each random segment. Sequence digits are never restricted; for example, a sequence ending in 9 remains valid.

## Persistence and allocation

- Store `sequence_number` independently from the public code in `campaign_codes`.
- Maintain one `campaign_code_counters` row per campaign.
- Existing codes, entries, payment orders, receipts, payment events, draw candidates and winners are preserved; the migration adds sequence metadata without rewriting public identifiers.
- Existing codes receive deterministic sequence metadata ordered by their database IDs within each campaign.
- Maintain one counter per campaign, initialized to at least 10001 and never reset on retry.
- Allocate sequence numbers under a MySQL transaction and row lock.
- Unique constraints protect both `(campaign_id, sequence_number)` and `(campaign_id, code)`.
- The campaign ID is the source of the public prefix; no hard-coded campaign prefix is used.
- Free entries and approved paid entries use the same allocation service.
- A repeated registration/payment approval returns the existing codes; it must not issue a second set.
- A failed Telegram notification must retry delivery of the already-issued code through the outbox, never allocate a replacement code.

## Migration recovery and production gate

- The migration is additive with respect to customer, payment and draw records; it contains no cleanup or delete statements.
- The nullable sequence column is backfilled before it is made non-null and uniquely indexed.
- Metadata checks and deterministic backfill allow a retry after partial DDL. Counter seeding uses `INSERT IGNORE` so it never resets an existing counter.
- MySQL DDL still commits independently. If migration execution fails, do not deploy or start the new application version. Inspect `schema_migrations`, the column, index and counter table, then rerun the migration runner after confirming the partial state.
- Production migration remains a separately approved deployment operation. Verify counts and backups before applying any production schema change.

This format is an identifier, not an authorization secret. Every lookup must validate the full code against the database and enforce participant/campaign ownership.
