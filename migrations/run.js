'use strict';
const mysql = require('mysql2/promise');
require('dotenv').config();
const { acquireMigrationLock } = require('../src/migration-lock');

async function main() {
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) {
    if (!String(process.env[key] || '').trim()) throw new Error(key + ' is required');
  }
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, charset: 'utf8mb4'
  });
  let releaseMigrationLock;
  try {
    releaseMigrationLock = await acquireMigrationLock(db, 'ustore_fresh_migrations', 30);
    const { up: migrateMultiCampaign } = require('./multi-campaign');
    const campaignResult = await migrateMultiCampaign(db);
    console.log('MULTI_CAMPAIGN_SCHEMA', JSON.stringify(campaignResult));

    await db.query(`CREATE TABLE IF NOT EXISTS telegram_sessions (
      telegram_user_id BIGINT NOT NULL PRIMARY KEY, chat_id BIGINT NOT NULL,
      step ENUM('profile_name','profile_awaiting_contact','profile_instagram','profile_confirmation','profile_change_full_name','profile_change_instagram','profile_change_phone_contact','support_message') NOT NULL,
      full_name VARCHAR(150) NULL, phone VARCHAR(25) NULL, instagram VARCHAR(40) NULL,
      business_connection_id VARCHAR(128) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_telegram_sessions_updated(updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.query(`CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, dedupe_key VARCHAR(128) NOT NULL UNIQUE,
      notification_type VARCHAR(64) NOT NULL, payload JSON NOT NULL,
      status ENUM('pending','processing','sent','failed') NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at TIMESTAMP NULL DEFAULT NULL,
      processing_started_at TIMESTAMP NULL DEFAULT NULL, processing_token CHAR(36) NULL DEFAULT NULL,
      last_error VARCHAR(500) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      sent_at TIMESTAMP NULL, KEY idx_notification_status_created(status,created_at,next_attempt_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.query(`CREATE TABLE IF NOT EXISTS admin_audit_log (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, admin_id VARCHAR(64) NOT NULL,
      action VARCHAR(64) NOT NULL, entity_type VARCHAR(64) NOT NULL, entity_id VARCHAR(64) NULL,
      details JSON NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_created(created_at), KEY idx_audit_entity(entity_type,entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.query(`CREATE TABLE IF NOT EXISTS webhook_inbox (
      update_id BIGINT NOT NULL PRIMARY KEY, payload JSON NOT NULL,
      status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0, last_error VARCHAR(500) NULL,
      received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processing_started_at TIMESTAMP NULL DEFAULT NULL, processing_token CHAR(36) NULL DEFAULT NULL,
      processed_at TIMESTAMP NULL, KEY idx_inbox_status_received(status,received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await db.query(`CREATE TABLE IF NOT EXISTS processed_updates (
      update_id BIGINT NOT NULL PRIMARY KEY,
      processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const migrations = [
      ['bank-cards', require('./bank-cards')],
      ['account-auth', require('./account-auth')],
      ['contact-gate', require('./contact-gate')],
      ['customer-flow', require('./customer-flow')],
      ['support-threads', require('./support-threads')]
    ];
    for (const [name, migration] of migrations) {
      const result = await migration.up(db);
      console.log(name.toUpperCase().replace(/-/g, '_') + '_MIGRATION', JSON.stringify(result));
    }
    console.log('MIGRATIONS_OK');
  } finally {
    try { if (releaseMigrationLock) await releaseMigrationLock(); }
    finally { await db.end(); }
  }
}
main().catch(err => { console.error('Migration failed:', err.stack || err.message); process.exit(1); });
