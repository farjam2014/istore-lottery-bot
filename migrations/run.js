'use strict';
const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  });
  try {
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
    await db.query("ALTER TABLE lottery_sessions MODIFY step ENUM('name','phone','instagram','awaiting_contact','awaiting_confirmation') NOT NULL");

    c = await columns('lottery_entries');
    if (!c.has('status')) await db.query("ALTER TABLE lottery_entries ADD COLUMN status ENUM('active','inactive','deleted') NOT NULL DEFAULT 'active'");
    if (!c.has('updated_at')) await db.query('ALTER TABLE lottery_entries ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    if (!c.has('deleted_at')) await db.query('ALTER TABLE lottery_entries ADD COLUMN deleted_at TIMESTAMP NULL');
    if (!c.has('deletion_reason')) await db.query('ALTER TABLE lottery_entries ADD COLUMN deletion_reason VARCHAR(255) NULL');

    await db.query('CREATE TABLE IF NOT EXISTS admin_audit_log (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, admin_id VARCHAR(64) NOT NULL, action VARCHAR(64) NOT NULL, entity_type VARCHAR(64) NOT NULL, entity_id VARCHAR(64) NULL, details JSON NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_audit_created(created_at), KEY idx_audit_entity(entity_type,entity_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await db.query("CREATE TABLE IF NOT EXISTS webhook_inbox (update_id BIGINT NOT NULL PRIMARY KEY, payload JSON NOT NULL, status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending', attempts INT UNSIGNED NOT NULL DEFAULT 0, last_error VARCHAR(500) NULL, received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP NULL, KEY idx_inbox_status_received(status,received_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    await db.query('CREATE TABLE IF NOT EXISTS released_codes (raffle_code VARCHAR(20) PRIMARY KEY, source_entry_id BIGINT UNSIGNED NOT NULL, released_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_released_at(released_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await db.query("CREATE TABLE IF NOT EXISTS lottery_code_history (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, entry_id BIGINT UNSIGNED NOT NULL, raffle_code VARCHAR(20) NOT NULL, action ENUM('assigned','released') NOT NULL, actor VARCHAR(80) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_code_history_entry(entry_id,created_at), KEY idx_code_history_code(raffle_code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    await db.query('CREATE TABLE IF NOT EXISTS lottery_draw_participants (draw_id BIGINT UNSIGNED NOT NULL, entry_id BIGINT UNSIGNED NOT NULL, raffle_code VARCHAR(20) NOT NULL, PRIMARY KEY(draw_id,entry_id), UNIQUE KEY uq_draw_code(draw_id,raffle_code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await db.query("INSERT IGNORE INTO lottery_settings(setting_key,setting_value) VALUES('registration_open','false'),('draw_completed','false')");
    await db.query("UPDATE lottery_settings SET setting_value='true' WHERE setting_key='draw_completed' AND EXISTS (SELECT 1 FROM lottery_draws)");
    await db.query("INSERT IGNORE INTO lottery_code_history(entry_id,raffle_code,action,actor) SELECT id,raffle_code,'assigned','migration' FROM lottery_entries WHERE status='active'");
    console.log('MIGRATIONS_OK');
  } finally {
    await db.end();
  }
}
main().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
