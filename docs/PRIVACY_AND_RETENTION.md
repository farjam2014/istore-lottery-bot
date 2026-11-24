# Privacy, Personal Data, and Retention

## Release status

**Release blocker:** this document is an engineering inventory and proposed operating policy, not legal advice or a substitute for a reviewed public privacy notice. The business owner must approve the purposes, retention periods, deletion exceptions, and contact channel, and the notice must be published before collecting live participant data.

## Data inventory

The application may process:

- Telegram identifiers, usernames, display names, and message/update metadata.
- Participant full name, phone number, and self-declared Instagram handle.
- Campaign participation, entry status, generated codes, and draw eligibility evidence.
- Payment order references, amounts, bank-card snapshots, Telegram receipt file identifiers, receipt notes, and review decisions.
- Support ticket subjects, messages, assignments, status, and timestamps.
- Admin identifiers, role changes, security/audit events, and export activity.
- Operational metadata such as update IDs, correlation IDs, retry state, and delivery errors.

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
| telegram_update_inbox | Completed records are retained for a short window; failed/stale records have a longer recovery window (worker policy). |
| processed_updates | Old deduplication records are periodically removed. |
| telegram_rate_limits | Old rate-limit buckets are periodically removed. |
| Participants, campaign entries, codes | No complete end-to-end retention/deletion policy is implemented. |
| Payment orders and receipts | No approved statutory/business retention schedule is encoded. |
| Support messages and tickets | No approved retention schedule is encoded. |
| Admin audit logs and export events | No approved retention schedule is encoded. |
| Outbox payloads | No complete retention schedule for sent/failed/uncertain payloads is approved. |

The short operational retention windows above are not a substitute for a complete personal-data retention policy.

## Required decisions before production launch

The business owner and qualified local counsel must approve:

- The public privacy notice, legal basis/consent language, and a privacy contact channel.
- Retention periods for participant profiles, campaign participation and draw evidence.
- Applicable statutory retention periods for financial records and payment receipts.
- Retention periods for support messages, Telegram file references, outbox payloads, audit logs, and exports.
- The process for access, correction, deletion, and objection requests, including exceptions where financial, fraud-prevention, or draw-integrity evidence must be retained.
- Whether data is transferred to, or processed by, hosting, Telegram, backup, monitoring, and other service providers, and the disclosures required.
- Who may approve a deletion/anonymization request and how the action is audited.

Do not delete payment, draw, or audit evidence automatically until the applicable retention and dispute requirements have been approved. Where deletion is approved, prefer a documented anonymization process that preserves only the minimum non-identifying integrity evidence required.

## Engineering safeguards required

- Keep personal data out of logs. The logger redaction list includes common Telegram, phone, Instagram, and actor identifiers; tests should cover nested and top-level keys.
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
