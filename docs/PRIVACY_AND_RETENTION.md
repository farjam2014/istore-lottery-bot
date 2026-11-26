# Privacy, Personal Data, and Retention

## Release status

**Release blocker:** this document is an engineering inventory and proposed operating policy, not legal advice or a substitute for a reviewed public privacy notice. The business owner must approve the purposes, retention periods, deletion exceptions, and contact channel, and the notice must be published before collecting live participant data.

## Data inventory

The application may process:

- Telegram identifiers, usernames, display names, and message/update metadata.
- Raw Telegram Update JSON stored in `telegram_update_inbox`; depending on update type this can include message text, callback data, contact name and phone number, photo file identifiers/captions, and other message metadata. The payload is stored in a MySQL JSON column and is not application-level encrypted by this code.
- Participant full name, phone number, and self-declared Instagram handle.
- Campaign participation, entry status, generated codes, and draw eligibility evidence.
- Payment order references, amounts, bank-card snapshots, Telegram receipt file identifiers, receipt notes, and review decisions.
- Support ticket subjects, messages, assignments, status, and timestamps.
- Admin identifiers, role changes, security/audit events, and export activity.
- Admin action idempotency records in `admin_action_idempotency`, including the acting Telegram ID, action type, entity reference, and creation timestamp, used to prevent duplicate administrative actions.
- Admin participant-search terms in `admin_search_sessions.query_text`; these may contain a name, phone number, Telegram ID, or Instagram handle and must be treated as personal data.
- In-progress payment-card administration sessions in `payment_card_admin_sessions.payload` and payment-settings wizard state; these may temporarily contain bank name, card number, cardholder name, and payment instructions.
- Operational metadata such as update IDs, correlation IDs, retry state, and delivery errors.
- In-progress registration session payloads, which can temporarily contain a name, verified phone number, and self-declared Instagram handle before a participant profile is created.

Telegram user IDs, phone numbers, Instagram handles, receipt references, and support content must be treated as personal or potentially identifying data. Access must be limited by role and business purpose.

## Purpose limitation

Use the data only to:
1. register and administer campaign participation;
2. verify eligibility and prevent duplicate or fraudulent registrations;
3. reconcile payments and review receipts;
4. issue and verify campaign codes and draw evidence;
5. provide customer support;
6. secure, troubleshoot, and audit the service.

Do not describe Instagram follow status or Instagram account ownership as verified unless a separate, documented verification integration actually performs that check.

## Retention controls currently present in code

| Data | Existing behavior |
|---|---|
| telegram_update_inbox raw payload | Stores the full Telegram Update JSON, not only update metadata. Completed payloads are deleted after 3 days; pending/failed and stale processing payloads are deleted after 30 days (worker policy). The payload may duplicate phone numbers, message text, names, callback data, and receipt file identifiers. |
| processed_updates | Records older than 3 days are deleted by the 15-minute retention worker. |
| telegram_rate_limits | Buckets older than 1 day are deleted by the 15-minute retention worker. |
| In-progress registration and pending receipt-upload sessions (`telegram_user_sessions`) | Session payloads may contain name, phone, Instagram handle, and payment-order reference. Sessions expire after 24 hours of inactivity and rows are physically deleted in bounded batches by the retention worker. The replay-cursor migration clears pre-cursor sessions, including pending receipt-upload prompts; submitted receipt records and payment orders are not deleted. The operational TTL still requires business/legal approval. |
| Admin participant-search terms (`admin_search_sessions.query_text`) | Search sessions expire after 24 hours and the retention worker physically deletes expired rows in bounded batches every 15 minutes. Query text can contain names, phone numbers, Telegram IDs, or Instagram handles. The 24-hour operational default still requires business/legal approval. |
| Payment-card administration sessions and payment-settings wizard state | Temporary card and payment-setting values are held in `payment_card_admin_sessions.payload` or `admin_wizards.payload`; expired rows are deleted in bounded batches every 15 minutes after 24 hours. The operational TTL and treatment of bank/card data still require business/legal approval. |
| Participant support/profile-change sessions | Text-session records expire 24 hours after they are started or explicitly restarted; invalid-message retries do not extend this window. Pre-cursor sessions are cleared during the replay migration and expired rows are physically deleted by the 15-minute retention worker. |
| Participants, campaign entries, codes | No complete end-to-end retention/deletion policy is implemented. |
| Payment orders and receipts | No approved statutory/business retention schedule is encoded. |
| Support messages and tickets | No approved retention schedule is encoded. |
| Admin audit log (`admin_audit_log`) | Records admin Telegram IDs, correlation IDs, action/entity references, timestamps, and action-specific JSON details. Migration `20261125_004_admin_audit_append_only.sql` installs database triggers that reject UPDATE and DELETE. There is no retention/archival worker or approved retention period. The append-only triggers mean a future retention process needs an explicitly reviewed archive-and-purge design; do not bypass the triggers ad hoc. |
| Payment event history (`payment_events`) | Records order references, actor Telegram IDs (including system actor `0`), event types, correlation IDs, timestamps, and event-specific details. No cleanup or archival path and no approved retention period are implemented. |
| Admin role history (`admin_role_events`) | Records target and actor Telegram IDs, role-change action, before/after role, and event time. No cleanup or archival path and no approved retention period are implemented. |
| Admin action idempotency records (`admin_action_idempotency`) | No cleanup path or approved retention period is currently implemented; records include admin Telegram IDs, action type, entity reference, and creation time. Retention must balance replay protection against indefinite storage of admin identifiers. |
| Outbox payloads and delivery errors (`telegram_notification_outbox`) | The worker stores the full Telegram payload (text, photo file reference, caption, and options) for pending, sending, sent, failed, and uncertain rows. No automatic Outbox payload purge is implemented. New worker versions store only fixed error classifications (`invalid_payload`, `telegram_http_429`, `telegram_http_4xx`, `telegram_http_5xx`, `network_or_unknown`) in `last_error`; older rows may contain raw exception text and must be treated as potentially sensitive. Manual retry is super-admin-only, per-notification, state-checked, and audited. Retrying an `uncertain` row can deliver a duplicate message because Telegram send methods do not provide an end-to-end idempotency key. No retention period is approved; do not purge payloads or financial/audit evidence until business/legal approval. |

The short operational retention windows above are not a substitute for a complete personal-data retention policy.

Outbox producers currently include:

- New payment-receipt alerts to finance/admin recipients: the chat ID, Telegram receipt photo file ID, receipt/order IDs, payment reference, campaign title, amount, requested code count, participant full name and phone, participant-supplied receipt note, and inline approval/rejection callback data.
- Payment decision notifications to participants: order reference plus issued campaign codes on approval, or the operator-provided rejection reason on rejection.
- Support notifications: free-form administrator reply text and ticket reference; profile-change notifications use a generic status message.
- Order-expiry notifications: a generic expiry message tied to the participant's Telegram chat ID.

This inventory is based on current source producers; future producers must be reviewed before adding payload fields. In particular, payment-receipt payloads are not merely delivery metadata: they contain personal data and payment evidence references.


## Outbox delivery and duplicate-send controls

- `pending` rows are claimed transactionally with `FOR UPDATE SKIP LOCKED` and a per-attempt lease token; only the worker holding the matching token may finalize the row.
- HTTP 429 responses are automatically retried with Telegram `retry_after` (or bounded backoff) and stop after the configured maximum attempts. Definite HTTP 4xx errors other than 429 become `failed`.
- Network errors, server errors, and expired `sending` leases become `uncertain`; they are not automatically resent because Telegram may already have accepted the message.
- Manual retry is restricted to a super-admin, one notification at a time, validates the expected prior state under a row lock, and writes an append-only admin audit event. The interface warns that retrying an `uncertain` notification may send a duplicate. This is an explicit operator override, not exactly-once delivery.
- The outbox worker does not generate campaign codes. A manual retry resends the stored payload; if that payload contains an already-issued code, the same code may be delivered again, but the retry path itself does not issue a new code.
- Outbox payloads remain stored after delivery/failure/uncertain status. No automated Outbox TTL is implemented or approved. There is no cleanup or archival path and no approved retention period. Treat these rows as personal/financial data and keep this as a launch blocker until the business owner and qualified local counsel approve retention, deletion/anonymization, and audit exceptions.

## Consent capture implementation

- Production startup requires `PRIVACY_NOTICE_URL` (HTTPS and non-placeholder) and `PRIVACY_NOTICE_VERSION`.
- New participants must acknowledge the published notice before entering name, phone, or Instagram details.
- Existing participant profiles with a missing or outdated consent version are gated until they acknowledge the current notice.
- The participant record stores the notice version and first acceptance timestamp. Replaying the same acceptance callback does not refresh the timestamp.
- This is an auditable notice acknowledgement, not a legal determination that consent is the correct legal basis. The business owner/legal reviewer must approve the notice text, purposes, retention schedule, and lawful basis before launch.

## Required decisions before production launch

The business owner and qualified local counsel must approve:

- The public privacy notice, legal basis/consent language, and a privacy contact channel.
- Retention periods for participant profiles, campaign participation and draw evidence.
- Applicable statutory retention periods for financial records and payment receipts.
- Retention periods for admin participant-search terms, payment-card/admin wizard session payloads, participant support/profile-change sessions, support messages, Telegram file references, outbox payloads, audit logs, and exports, including automated cleanup of expired session/query rows.
- Retention and safe expiry policy for admin action idempotency records, balancing replay protection against indefinite storage of admin identifiers.
- The process for access, correction, deletion, and objection requests, including exceptions where financial, fraud-prevention, or draw-integrity evidence must be retained.
- Whether data is transferred to, or processed by, hosting, Telegram, backup, monitoring, and other service providers, and the disclosures required.
- Who may approve a deletion/anonymization request and how the action is audited.

Do not delete payment, draw, or audit evidence automatically until the applicable retention and dispute requirements have been approved. Where deletion is approved, prefer a documented anonymization process that preserves only the minimum non-identifying integrity evidence required.

## Engineering safeguards required

- Keep personal data out of logs. The logger redaction list includes common Telegram, phone, Instagram, and actor identifiers; unit tests cover nested and top-level keys.
- Treat `telegram_update_inbox.payload` and its backups as personal data. Restrict database/backup access, apply the same approved retention and deletion policy, and do not copy raw payloads into diagnostics or exports.
- Keep participant export and payment export behind explicit permissions. Export actions must be audited.
- Support agents must not receive global participant-profile access by default.
- Do not place full receipt contents, phone numbers, or participant profiles in operational logs.
- Keep backups encrypted, access-controlled, and subject to the same retention schedule.
- Restrict access to generated CSV files and delete temporary copies after authorized delivery.
- Review privacy access logs and export events periodically.

## Launch checklist

- [ ] Legal/business owner approves this policy and the retention schedule.
- [ ] Public privacy notice is published and linked from the bot registration flow.
- [ ] Access/correction/deletion request workflow is documented and tested.
- [ ] Financial, support, audit, outbox, and backup retention periods are configured.
- [ ] Log redaction tests cover nested Telegram IDs and other identifiers.
- [ ] Export permissions and export audit tests pass.
- [ ] Backup access and deletion behavior are documented.
