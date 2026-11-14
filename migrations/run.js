'use strict';
const mysql = require('mysql2/promise');
require('dotenv').config();
const { acquireMigrationLock } = require('../src/migration-lock');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  });
  let releaseMigrationLock;
  try {
    releaseMigrationLock = await acquireMigrationLock(db, 'istore_lottery_migrations', 30);
    const [tables] = await db.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
    );
    const existing = new Set(tables.map(row => row.TABLE_NAME));
    for (const required of ['processed_updates','webhook_inbox','admin_audit_log','telegram_notification_outbox']) {
      if (!existing.has(required)) throw new Error('Infrastructure schema is incomplete; import the new schema.sql first: '+required);
    }

    const { up: migrateMultiCampaign } = require('./multi-campaign');
    const multiCampaignResult = await migrateMultiCampaign(db);
    console.log('MULTI_CAMPAIGN_MIGRATION', JSON.stringify(multiCampaignResult));

    const { up: migrateBankCards } = require('./bank-cards');
    const bankCardResult = await migrateBankCards(db);
    console.log('BANK_CARD_MIGRATION', JSON.stringify(bankCardResult));

    const [legacyTables] = await db.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('lottery_entries','lottery_sessions','lottery_settings','lottery_draws','lottery_draw_participants','released_codes','lottery_code_history','legacy_entry_mappings')"
    );
    if (legacyTables.length) {
      throw new Error('Legacy single-campaign tables remain in this database. Use a fresh database install; migration will not import or silently delete legacy data: '+legacyTables.map(row=>row.TABLE_NAME).join(', '));
    }
    console.log('MIGRATIONS_OK');
  } finally {
    try {
      if (releaseMigrationLock) await releaseMigrationLock();
    } finally {
      await db.end();
    }
  }
}
main().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
