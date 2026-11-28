# Audit Remediation Traceability — Release Candidate

## Scope and safety

- Repository: `farjam2014/istore-lottery-bot`
- Release base: `release/ustore-unified` at `50cf25f57bc081b5e3e64e9f1b980de894c1ea62`
- Candidate: `remediation/release-hardening-release-base`
- Main review PR: Draft PR81
- Default-branch runner removal: companion Draft PR82, based on `main`
- This is a source and CI remediation record. It is not deployment approval.
- No Production VPS, database, secrets, service, or participant data were accessed or modified by this remediation.

## Findings mapped to the nine audit areas

| Area | Finding / change | Evidence in candidate | Status |
|---|---|---|---|
| 1. Campaign lifecycle and concurrency | Campaign creation locks and consumes the wizard in the same transaction as insert and audit. Campaign copy is transactionally audited and idempotent by Telegram callback ID. Campaign/admin status callbacks use expected-state checks. Campaign edit and draw-publication wizards are locked and consumed atomically. | `campaign-admin.service.js`; `admin.handler.js`; `admin-access.service.js`; campaign unit and MySQL concurrency tests. | Code remediation implemented; final-head CI required. |
| 2. Payments and bank-card administration | Card create/update/default/active changes write audit events in the same transaction. Legacy `/payment_settings` routes through the audited service. Payment receipt approval remains transactionally idempotent with code issuance. | `bank-card.service.js`; `payment.service.js`; `payment.handler.js`; bank-card unit tests and MySQL payment concurrency tests. | Code remediation implemented; final-head CI required. |
| 3. Support and customer operations | User/admin support-session consumption is locked before ticket/reply creation. Assignment, status, and priority mutations are transactional and audited. | `user.handler.js`; `admin.handler.js`; MySQL support concurrency test. | Code remediation implemented; final-head CI required. |
| 4. Admin authorization and sensitive exports | Global participant-directory access is distinct from campaign-scoped lookup. Support agents do not receive global participant access. Participant/code exports require explicit export permission; payment exports require `payment.export`, omit participant contact/Telegram identifiers, and are audited. | `permissions.js`; `admin.handler.js`; `payment-admin.service.js`; permission and export tests. | Code remediation implemented; final-head CI required. |
| 5. Telegram inbox/outbox reliability | Ambiguous network and server outcomes become `uncertain`, not automatic retries. Telegram 429 is retried with `retry_after`; permanent 4xx is terminal. Manual retry is one notification at a time, with status recheck, warning, and audit. Registration step advancement stores the Telegram update ID to prevent replayed text/contact updates from advancing twice. | `outbox.worker.js`; `outbox-admin.service.js`; participant repository/registration handler; outbox and registration replay tests. | Code remediation implemented; final-head CI required. |
| 6. Database migrations and lock safety | Uncertain GET_LOCK/RELEASE_LOCK connections are destroyed rather than returned to the pool. Replay guards cover identified multi-statement legacy migrations and new idempotency/privacy/registration-session migrations. | `migrate.js`; `migration-lock.js`; migration-lock unit tests; MySQL migration-replay tests. | Code remediation implemented for identified states; guards do not make arbitrary schema drift safe. Production preflight remains mandatory. |
| 7. Privacy and personal data | Logs redact Telegram/user/chat/phone/Instagram identifiers. Production requires a published HTTPS privacy notice URL and version. New users acknowledge before personal-data collection; existing users must re-acknowledge after version change. Consent version and timestamp are persisted. Re-accepting the notice preserves partial registration progress. | `log-redaction.js`; `profile-gate.js`; `registration.handler.js`; participant repository; privacy tests and migrations. | Engineering controls implemented. Public notice review, lawful basis, retention periods, deletion/anonymization workflow, and local legal approval remain open release gates. |
| 8. Draw integrity, key custody, and backup/restore | Production startup validates the draw keyring. Draw proof remains reproducible with commitment, encrypted seed, snapshot hash, and offline verifier. CI backup/restore test verifies prepared-draw ciphertext and historical fixture-key recovery. | `index.js`; `draw-keyring.js`; draw verifier/docs; backup/restore integration test. | Partial. No independent entropy source or independent eligibility register is implemented; do not describe the draw as trustless or impossible for an operator to manipulate. No real Production backup restore or Production keyring recovery rehearsal has been performed. |
| 9. CI/CD, installer, runner, and production operations | CI uses explicit read-only contents permission, pinned action SHAs, remediation-branch coverage, and full dependency audit. Installer inventories tracked and untracked files and does not echo remote URLs. Two persistent self-hosted diagnostics workflows are scheduled for removal through Draft PR82 on `main`. | `.github/workflows/ci.yml`; `install.sh`; installer tests; Draft PR82. | Partial. PR82 is not merged; branch protection/required checks are absent; runner isolation/sudo helper are not host-verified; installer is not the release-directory deployment method. |

## CI evidence

The authoritative evidence is the latest successful GitHub Actions run attached to the exact current PR81 head SHA. A successful run on an earlier SHA is not evidence for a later commit. The CI job runs:

- `npm ci`
- `npm audit --audit-level=high`
- `npm test`, including MySQL concurrency/migration tests and backup/restore integration
- JavaScript syntax checks
- Bash syntax checks

Record the final head SHA, run URL, test counts, and audit result in the PR body only after that exact head has completed successfully.

## External release gates — cannot be closed by this source PR

1. Read-only VPS evidence must confirm the live systemd unit, `WorkingDirectory`, process cwd, active commit, service state, working tree, and restricted `.env` metadata.
2. The exact Production database migration history and schema must be inventoried with the read-only preflight.
3. A real Production backup must be restored to a separate disposable database; table counts, orders, receipts, codes, prepared draws, and proofs must be checked.
4. Every historical draw key referenced by Production must be recovered from an independent encrypted backup and successfully decrypt a prepared draw.
5. The business must publish and approve the privacy notice, retention/deletion schedule, and participant re-acknowledgement plan.
6. Branch protections and required checks must be applied to `main` and release branches.
7. PR82 must remove the persistent self-hosted workflows from `main`; the runner must remain unused until isolation and sudo boundaries are verified.
8. A Telegram Bot API end-to-end smoke test must be performed in staging using a non-production bot token.
9. The draw must be marketed accurately: commitment-based/offline-verifiable, not trustless or independent of operator-controlled eligibility data.

## Release decision

**Current decision: NO-GO for Production launch.**

PR81 can become a review-ready source candidate only after the latest exact head CI is green and the diff receives independent review. Production launch remains blocked until all external gates above are evidenced. Do not merge, deploy, restart, migrate, or run Production writes as part of this PR.
