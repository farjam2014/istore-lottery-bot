# Payment operations center

The admin panel's **Payment orders** entry opens a searchable, paginated payment operations center.

## Capabilities
- Filter orders by all, awaiting receipt, under review, approved, rejected, cancelled, and expired.
- Search by exact order ID, exact payment reference, Telegram user ID, or partial phone number.
- Open an order to inspect participant and campaign details, the immutable bank-card snapshot, order dates, rejection reason, receipts, and payment event history.
- Review submitted receipts from the order detail view. Approve/reject actions continue to use the payment-review permission.
- Export up to the latest 10,000 orders to CSV. Amounts are in IRR; CSV cells are escaped against spreadsheet formula injection.

## Access
The list, search, detail and export actions require \`payment.read\`. Approving or rejecting a receipt requires \`payment.review\`. Updating bank-card settings requires \`payment.settings\`. The finance manager role has these permissions; campaign managers and support agents do not.

## Deployment
Apply the additive migration \`20261114_005_payment_admin_sessions.sql\` before using the order search UI. No existing order or receipt rows are rewritten by this migration.
