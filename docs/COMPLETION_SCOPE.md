# iStore — Completion Scope and Acceptance Plan

## Scope of this release
This release includes customer registration, campaign operations, participant management, orders/payments, account, support, reporting/export, security/reliability, and the implemented verifiable draw workflow (prepare, commitment publication attestation, deterministic winner selection, reveal, and offline proof verification). Live gateway integration and independent eligibility reconciliation remain deferred. Draw proof limitations and operator trust boundaries are documented in `docs/VERIFIABLE_DRAWS.md`.

## Approved product invariants
- Draw model remains code-based; a code is one independent ticket.
- A participant can win at most one prize per campaign; the draw service enforces unique participant winners and verifies the committed candidate snapshot.
- Draws require a closed campaign, no unresolved payment reservations, a committed seed and candidate snapshot, an HTTPS publication attestation before completion, and a supported algorithm version. The publication attestation is not independently verified.
- Payments support manual bank-transfer evidence and a provider-neutral online-payment abstraction. Gateway provider selection and live gateway integration are deferred.
- Paid campaigns price each code individually; participants select a quantity up to the configured per-participant maximum. Order amount and requested quantity are snapshotted, and approved receipts issue exactly that quantity.
- Campaign capacity is measured in codes, including issued codes and active payment reservations; reservations are released on expiry/cancellation.
- Free campaigns retain their configured fixed codes-per-participant quantity, and capacity is checked against the number of codes issued.
- Campaign limits are separately configurable by admins.
- Support supports tickets and direct chat, but every message is persisted centrally.
- Admin model uses server-side role permissions: environment-configured super-admins and assignable campaign-manager, finance-manager, and support-agent roles. Role assignment and access changes are audited; super-admins are not assignable through the ordinary role wizard.

## Registration and customer profile
- Required fields only: full name, verified mobile number, Instagram handle.
- Mobile number must be collected with Telegram's contact-request button, not typed manually.
- Accept a shared contact only when Telegram supplies contact.user_id matching ctx.from.id; reject forwarded/other contacts. Normalize and persist phone in E.164 form.
- Do not infer ownership from a typed number, username or contact name.
- Profile view includes account status, registration timestamp, campaigns joined, issued-code count, orders/payments and support tickets.
- Profile edits are requests; approval updates current profile while campaign entry snapshots remain immutable.

## Campaign administration
- Fields: title, description, campaign poster/photo, prize name/description, estimated prize value, start/end timestamps, planned draw timestamp (metadata only), campaign terms, capacity, codes per entry, participation type, price and allowed payment methods.
- Provide complete preview before save; create draft by default.
- Status transitions must be validated: draft -> scheduled/open; open -> paused/closed; scheduled -> open/paused; closed/archived as controlled transitions. Do not silently reopen ended campaigns.
- Show remaining capacity, current participant count, issued code count, status and time remaining.
- Campaign discovery filters and future/ended campaign catalog search are deferred as requested; campaign details still show current/closed state when reached from an order/history.

## Participant management
- Paginated list of all registered users; profile details; registration date; active/blocked status.
- Per-user campaign participation history, per-campaign issued codes, order/payment states, receipt references and support history.
- Admin can block/unblock with audit record; blocking prevents new entries/orders but must not erase history.
- CSV export must be streamed or bounded/paginated, UTF-8 with BOM for spreadsheet compatibility, formula-injection-safe, and must not expose secrets or raw Telegram file tokens.

## Orders and payment operations
- Stable human-readable payment reference per order, unique and searchable.
- Immutable order amount, currency, campaign, bank destination snapshot and timestamps.
- Receipt photo metadata, duplicate-file detection, reviewer, decision, rejection reason and full payment event history.
- Approve/reject must be transactional and idempotent. Codes issue only after approval.
- Pending-receipt order has a visible Continue payment button. Rejected order can resubmit a new receipt while valid.
- At 24-hour expiry, order/reservation expires, pending entry is cancelled/released, user is notified and can start a fresh campaign entry/order if campaign remains open and capacity is available.
- A scheduled expiry worker is required; checking expiry only when the user returns is insufficient.
- Capacity reservation and release must be atomic and concurrency-safe.
- Financial report: totals by date/campaign/method/status; approved vs pending vs rejected vs expired; receipt reconciliation; export; immutable payment identifiers.
- Online gateway integration stays provider-neutral until provider chosen. Browser redirect is never payment proof; server-side verification and idempotency are mandatory.

## User menu and help
- Campaign list/details and terms/instructions.
- My codes with campaign and issue date.
- Orders with status, payment reference, amount, expiry and next action.
- Account with profile and history.
- Support ticket create/list/detail/reply/close/reopen, plus direct support messages recorded in the same conversation history.
- Provide clear participation guide, payment guide, receipt rules, privacy note and campaign-specific terms.

## Support operations
- Queues: new, in progress, answered, closed.
- Ticket categories: financial, campaign/participation, technical, security, other.
- Priority: critical/high/normal/low; financial and security cases can be escalated.
- Assign/reassign to any shared admin, reply to user, full timeline, close/reopen, audit every state/assignment/priority change.
- User can see ticket list, status and full message history.

## Security and reliability acceptance gates
- Server-side authorization for every callback and command.
- Validate ownership for every user resource lookup.
- Rate-limit registration, order creation, receipt submission and support creation.
- Process Telegram update IDs idempotently.
- Database transactions and unique constraints protect payment approvals and code issuance.
- Versioned additive migrations; never use CREATE TABLE IF NOT EXISTS as a substitute for schema evolution.
- Notification outbox with retries and dead-letter visibility.
- Structured logs with sensitive data redacted; never log bot token, full card number or receipt file IDs unnecessarily.
- UTC storage and explicit Persian/local display formatting.
- Tests cover code issuance, payment quantity, registration state transitions, contact ownership, campaign transitions, draw integrity, migration guards, notification delivery and authorization. MySQL concurrency and production recovery remain separate release acceptance drills.
- No production DB mutation, VPS deployment, or bot restart without explicit approval.

## User-interface convention
All navigation and action choices are inline Telegram buttons placed beneath the relevant message. Text input remains appropriate only for actual free-form data (name, Instagram handle, campaign copy, support message, rejection reason). Do not ask users to type menu commands for normal workflows. Contact sharing uses Telegram's native contact-request keyboard.
