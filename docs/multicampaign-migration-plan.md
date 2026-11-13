# Multi-campaign architecture migration plan

## Current repository audit (feature/complete-telegram-lottery-system)

Inspected:
- `src/index.js`
- `src/admin-telegram.js`
- `src/domain.js`
- `schema.sql`
- `migrations/run.js`
- `package.json`
- `README.md`
- `install.sh`

### Confirmed current design constraints

1. `lottery_entries` is currently both the participant profile and the single campaign entry:
   - `telegram_user_id` is globally unique.
   - `raffle_code` is globally unique.
   - The row stores name, phone, Instagram, chat ID, status and code together.
2. Registration state is global:
   - `lottery_settings.registration_open` controls all registration.
   - `draw_completed` is a global one-draw lock.
3. Draw logic selects all active `lottery_entries`; it is not scoped to a campaign.
4. Current codes are random `LOT-XXXXXXXX` values from `src/domain.js`, not campaign-scoped sequential opaque codes.
5. README explicitly states real payment collection is not implemented.
6. Existing registration rejects duplicate active phone or Instagram across all entries. This needs a deliberate product decision during migration because profiles are now Telegram-identity based and entries become campaign-specific.
7. Existing admin Telegram UI is built around one global campaign. It needs campaign selection/context, not merely additional menu buttons.

## Target decisions confirmed by owner

- Identity key: Telegram numeric user ID.
- At most one entry/code per participant per campaign.
- Campaign capacity: either unlimited or a manager-configured cap.
- Participant profile is reusable across campaigns; joining each new campaign remains an explicit user action.
- Campaign-specific opaque code with a private monotonic sequence stored internally.
- Future campaign payment modes: free, manual bank-transfer proof review, or approved payment-provider integration. Payment mode must remain disabled until legal/provider eligibility is confirmed.

## Migration principles

- Do not drop or rename current production tables during the first migration.
- Preserve all existing participant rows, code history, draw snapshots, webhook inbox, processed updates and audit records.
- Treat the current single campaign as a legacy campaign and backfill each active/inactive/deleted legacy entry into a profile plus one campaign-entry record.
- Preserve existing raffle codes exactly for legacy entries; do not regenerate them.
- Keep legacy global registration/draw behavior isolated behind an explicit legacy campaign mapping during transition.
- Enforce one entry per (campaign_id, participant_id) with a database unique key.
- Enforce one code per entry and uniqueness of (campaign_id, code).
- Capacity allocation and code issuance must happen in one InnoDB transaction with row-level locking.
- Payment proof upload or client redirect must never by itself issue a code; only an authenticated manager approval or server-verified provider confirmation may do so.
- Archive campaigns with history; do not hard-delete campaigns with entries, codes, payments or draws.

## Implementation phases

1. Schema and migration: add participants, campaigns, campaign_entries, campaign_sequences, issued_codes, payments, payment_proofs and campaign-scoped draw tables; backfill legacy data transactionally and idempotently.
2. Domain services: profile upsert by Telegram ID, campaign eligibility, capacity locking, one-entry idempotency, opaque deterministic code derivation using a server-held secret, and payment state transitions.
3. Telegram user flow: profile completion once, list active campaigns, explicit join, return existing code on repeat request.
4. Admin operations: create/edit/pause/close/archive campaign, capacity and payment settings, campaign-scoped participant/code/export/draw views.
5. Tests: migration from current schema with populated fixtures, repeat join, parallel capacity race, code uniqueness, payment approval/rejection, draw isolation and legacy compatibility.
6. Deployment: backup, deploy only from a reviewed branch, run migration, verify health and Telegram Business flow; do not open public registration automatically.

## Known deployment constraint

The VPS has a self-hosted GitHub Actions runner, but no deployment workflow has been verified yet. Do not execute unreviewed repository code on the persistent production runner. GitHub documents that self-hosted runners can expose host files, secrets and internal services to workflow code; use least privilege and a reviewed deployment path. Direct SSH access is not available in this work session.

## Release gates

- Existing bot remains operational during development.
- `REGISTRATION_OPEN=false` remains in force until an explicit launch decision.
- No production schema migration before verified backup and populated-fixture migration tests.
- Existing draft PR #3 remains draft and is never merged automatically.
- `main` remains untouched.
