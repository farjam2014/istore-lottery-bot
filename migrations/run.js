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
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
    );
    const existingTables = new Set(tables.map(x => x.TABLE_NAME));
    if (!existingTables.has('lottery_entries') || !existingTables.has('lottery_sessions')) {
      throw new Error('Base tables are missing. Import the corrected schema.sql first.');
    }

    async function columns(table) {
      const [rows] = await db.execute(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
        [table]
      );
      return new Set(rows.map(x => x.COLUMN_NAME));
    }
    let c = await columns('lottery_sessions');
    if (!c.has('instagram')) await db.query('ALTER TABLE lottery_sessions ADD COLUMN instagram VARCHAR(40) NULL AFTER phone');
    await db.query('ALTER TABLE lottery_sessions MODIFY instagram VARCHAR(40) NULL');
    await db.query("ALTER TABLE lottery_sessions MODIFY step ENUM('name','phone','instagram','awaiting_contact','awaiting_confirmation') NOT NULL");

    c = await columns('lottery_entries');
    if (!c.has('status')) await db.query("ALTER TABLE lottery_entries ADD COLUMN status ENUM('active','inactive','deleted') NOT NULL DEFAULT 'active'");
    if (!c.has('updated_at')) await db.query('ALTER TABLE lottery_entries ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    if (!c.has('deleted_at')) await db.query('ALTER TABLE lottery_entries ADD COLUMN deleted_at TIMESTAMP NULL');
    if (!c.has('deletion_reason')) await db.query('ALTER TABLE lottery_entries ADD COLUMN deletion_reason VARCHAR(255) NULL');

    // Abort before adding unique indexes if existing active records collide.
    const [phoneDuplicates] = await db.query("SELECT phone, COUNT(*) AS n FROM lottery_entries WHERE status='active' GROUP BY phone HAVING COUNT(*) > 1 LIMIT 1");
    if (phoneDuplicates.length) throw new Error('Duplicate active phone numbers exist; resolve them before migration.');
    const [instagramDuplicates] = await db.query("SELECT LOWER(instagram) AS normalized_instagram, COUNT(*) AS n FROM lottery_entries WHERE status='active' GROUP BY LOWER(instagram) HAVING COUNT(*) > 1 LIMIT 1");
    if (instagramDuplicates.length) throw new Error('Duplicate active Instagram handles (case-insensitive) exist; resolve them before migration.');

    c = await columns('lottery_entries');
    if (!c.has('active_phone')) await db.query("ALTER TABLE lottery_entries ADD COLUMN active_phone VARCHAR(25) GENERATED ALWAYS AS (CASE WHEN status='active' THEN phone ELSE NULL END) STORED");
    c = await columns('lottery_entries');
    if (!c.has('active_instagram')) await db.query("ALTER TABLE lottery_entries ADD COLUMN active_instagram VARCHAR(40) GENERATED ALWAYS AS (CASE WHEN status='active' THEN LOWER(instagram) ELSE NULL END) STORED");
    const [entryIndexes] = await db.query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lottery_entries'");
    const indexNames = new Set(entryIndexes.map(x => x.INDEX_NAME));
    if (!indexNames.has('uq_entries_active_phone')) await db.query('ALTER TABLE lottery_entries ADD UNIQUE KEY uq_entries_active_phone(active_phone)');
    if (!indexNames.has('uq_entries_active_instagram')) await db.query('ALTER TABLE lottery_entries ADD UNIQUE KEY uq_entries_active_instagram(active_instagram)');

    await db.query('CREATE TABLE IF NOT EXISTS admin_audit_log (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, admin_id VARCHAR(64) NOT NULL, action VARCHAR(64) NOT NULL, entity_type VARCHAR(64) NOT NULL, entity_id VARCHAR(64) NULL, details JSON NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_audit_created(created_at), KEY idx_audit_entity(entity_type,entity_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await db.query("CREATE TABLE IF NOT EXISTS webhook_inbox (update_id BIGINT NOT NULL PRIMARY KEY, payload JSON NOT NULL, status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending', attempts INT UNSIGNED NOT NULL DEFAULT 0, last_error VARCHAR(500) NULL, received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP NULL, KEY idx_inbox_status_received(status,received_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    c = await columns('webhook_inbox');
    if (!c.has('processing_started_at')) await db.query('ALTER TABLE webhook_inbox ADD COLUMN processing_started_at TIMESTAMP NULL DEFAULT NULL AFTER received_at');
    if (!c.has('processing_token')) await db.query('ALTER TABLE webhook_inbox ADD COLUMN processing_token CHAR(36) NULL DEFAULT NULL AFTER processing_started_at');
    await db.query('CREATE TABLE IF NOT EXISTS released_codes (raffle_code VARCHAR(20) PRIMARY KEY, source_entry_id BIGINT UNSIGNED NOT NULL, released_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_released_at(released_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await db.query("CREATE TABLE IF NOT EXISTS lottery_code_history (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, entry_id BIGINT UNSIGNED NOT NULL, raffle_code VARCHAR(20) NOT NULL, action ENUM('assigned','released') NOT NULL, actor VARCHAR(80) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_code_history_entry(entry_id,created_at), KEY idx_code_history_code(raffle_code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    await db.query('CREATE TABLE IF NOT EXISTS lottery_draw_participants (draw_id BIGINT UNSIGNED NOT NULL, entry_id BIGINT UNSIGNED NOT NULL, raffle_code VARCHAR(20) NOT NULL, PRIMARY KEY(draw_id,entry_id), UNIQUE KEY uq_draw_code(draw_id,raffle_code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await db.query("INSERT IGNORE INTO lottery_settings(setting_key,setting_value) VALUES('registration_open','false'),('draw_completed','false')");
    await db.query("UPDATE lottery_settings SET setting_value='true' WHERE setting_key='draw_completed' AND EXISTS (SELECT 1 FROM lottery_draws)");
    await db.query(`
  INSERT INTO lottery_code_history(entry_id, raffle_code, action, actor)
  SELECT e.id, e.raffle_code, 'assigned', 'migration'
  FROM lottery_entries e
  WHERE e.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM lottery_code_history h
      WHERE h.entry_id = e.id
        AND h.raffle_code = e.raffle_code
        AND h.action = 'assigned'
        AND h.actor = 'migration'
    )
`);
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
