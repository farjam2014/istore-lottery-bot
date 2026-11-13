# Platform Architecture

## Product decision

The website and Telegram bot are two clients of one platform. They must use the same application services and MySQL records. Business rules must not be reimplemented separately in the website and bot handlers.

The platform supports:
- Free campaigns.
- Manual card-to-card payment with receipt review.
- Online gateway payment with server-side verification.
- System-selected draws and live-wheel presentation.
- A public verification page for issued codes and published draw results.

## Target boundaries

1. **Clients**
   - Telegram bot: registration, account access, orders, receipts, notifications, support.
   - Website: public campaign pages, participant account, checkout, code verification, live draw presentation.
   - Admin website and Telegram admin tools: campaign, payment, participant and draw operations.

2. **Application services**
   - Identity and account linking.
   - Campaign and eligibility rules.
   - Orders, reservations and payment orchestration.
   - Code issuance and immutable code history.
   - Draw preparation, selection, approval and publication.
   - Notifications, support and reporting.

3. **Persistence**
   - MySQL is the single source of truth.
   - All state-changing operations use transactions and appropriate row locks.
   - Unique constraints enforce idempotency and prevent duplicate identities, orders and codes.
   - Audit records capture privileged changes.

4. **Asynchronous work**
   - Telegram webhook inbox and notification outbox remain durable.
   - Payment callbacks are authenticated, idempotent and verified server-to-server.
   - Background workers retry transient failures without repeating business effects.

## Account and identity model

Introduce a central account record and linked identities. A Telegram identity is unique and maps to one account. A participant profile belongs to that account and is reused across campaigns and website sessions. Linking a website session to Telegram must require proof of control of the Telegram account; a phone number alone is not sufficient.

Planned additive tables:
- `users`: canonical account and account status.
- `user_identities`: provider, provider subject, verification timestamp; unique per provider and subject.
- `web_sessions`: hashed session token, expiry, revocation and rotation metadata.

Existing participant and campaign records must be migrated additively and mapped deterministically. Do not drop or recreate existing tables.

## Payment state rules

- A manual-payment order reserves capacity while payment is pending.
- A receipt is accepted only if it is submitted before the order's payment deadline.
- Once a timely receipt is submitted, the reservation remains held until an administrator approves or rejects it. The payment-deadline worker must not expire it while review is pending.
- Approval, transaction recording, reservation commitment and code issuance occur in one database transaction.
- Rejection records the decision and releases capacity transactionally.
- Gateway success is never inferred from a browser redirect. The server verifies the provider transaction and amount before committing the order.
- Every provider callback and state-changing request is idempotent.

## Draw integrity

The draw engine snapshots eligible entries, hashes the snapshot, records the algorithm version and selection evidence, and stores results pending approval. A live wheel is presentation only: it must display a result already selected and recorded by the draw engine. Public results expose only approved fields and never disclose private participant data.

## Delivery sequence

### Phase 0 — Stabilize current behavior
- Fix receipt deadline versus delayed administrator review.
- Add regression tests for reservation lifecycle and payment review.
- Verify campaign capacity, duplicate handling, idempotency and transaction boundaries.
- Establish repeatable CI checks before any production deployment.

### Phase 1 — Central identity
- Add users, linked identities and web sessions through additive migrations.
- Link existing Telegram participants without changing their Telegram IDs.
- Add secure Telegram account linking and website session lifecycle.
- Keep the existing admin login isolated until role-based access is implemented.

### Phase 2 — Shared application API
- Move reusable campaign/account operations behind service methods.
- Add authenticated participant API routes.
- Make website and bot call the same services.
- Add CSRF, origin, rate-limit and authorization tests for web mutations.

### Phase 3 — Payment orchestration
- Keep manual receipt review.
- Add a provider adapter interface and a concrete gateway only after selecting a supported provider.
- Verify payment status, amount, currency and merchant reference server-side.
- Add callback replay, timeout, cancellation and reconciliation tests.

### Phase 4 — Participant website
- Public campaign discovery and campaign details.
- Shared account, orders, receipts, code wallet and support.
- Public code verification with privacy-safe responses.

### Phase 5 — Draw publication
- Snapshot and audit improvements.
- System draw verification and public evidence.
- Live presentation that consumes the approved result.
- Winner notification and public archive.

### Phase 6 — Operations and analytics
- Role-based admin access.
- Finance and campaign reports, exports and support workflows.
- Monitoring, alerting, retention and recovery procedures.

## Non-goals for the first implementation pass

- No production VPS changes.
- No running the destructive installer.
- No dropping or recreating the database.
- No gateway credentials or provider-specific integration until the provider is chosen.
- No claim that code is production-ready until automated and acceptance tests pass.
