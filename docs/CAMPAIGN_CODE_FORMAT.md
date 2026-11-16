# Campaign code format

## Public format

`P{campaign_id}-{six_character_middle}-{two_character_suffix}`

- `P` means Project.
- The decimal campaign database ID follows `P` (for example, campaign ID 13 becomes `P13`).
- The middle segment is always exactly six characters.
- The final suffix is always exactly two characters.
- All generated letters are uppercase.

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

Every campaign starts at sequence 10001. The maximum supported sequence is 999999.

## Random-character rule

Random positions use `ABCDEFGHJKLMNPQRSTUVWXYZ0123456789` (ambiguous I and O are excluded). The final character of each random segment is restricted to `ABCDEFGHJKLMNPQRSTUVWXYZ0`.

There are two random segments:
1. The random prefix before the sequence in the middle segment. If its length is non-zero, its last character must be a letter or `0`.
2. The two-character suffix. Its first character may use the full random alphabet; its second character must be a letter or `0`.

The restriction applies only to the last character of each random segment. Sequence digits are never restricted; for example, a sequence ending in 9 remains valid.

## Persistence and allocation

- Store `sequence_number` independently from the public code in `campaign_codes`.
- Maintain one `campaign_code_counters` row per campaign.
- Allocate sequence numbers under a MySQL transaction and row lock.
- Unique constraints protect both `(campaign_id, sequence_number)` and `(campaign_id, code)`.
- The campaign ID is the source of the public prefix; no hard-coded campaign prefix is used.
- Free entries and approved paid entries use the same allocation service.
- A repeated registration/payment approval returns the existing codes; it must not issue a second set.
- The one-time migration deliberately deletes every currently issued campaign code because they are disposable test records. It also clears draw candidates, winners, and draw records because all draw history is disposable test data. Campaigns, participants, entries, orders and payment receipts are retained.
- Every campaign's sequence counter is reset to 10001. The first new code issued after migration uses sequence 10001.
- A failed Telegram notification must retry delivery of the already-issued code through the outbox, never allocate a replacement code.

This format is an identifier, not an authorization secret. Every lookup must validate the full code against the database and enforce participant/campaign ownership.
