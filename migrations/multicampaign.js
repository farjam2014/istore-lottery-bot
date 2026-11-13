'use strict';

// Additive, repeatable migration. Legacy tables remain untouched.
async function migrateMultiCampaign(db) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS participants (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      phone VARCHAR(25) NOT NULL,
      instagram VARCHAR(40) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_participants_telegram(telegram_user_id),
      KEY idx_participants_phone(phone),
      KEY idx_participants_instagram(instagram)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS campaigns (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(64) NOT NULL,
      title VARCHAR(160) NOT NULL,
      status ENUM('draft','scheduled','active','paused','closed','archived') NOT NULL DEFAULT 'draft',
      starts_at DATETIME NULL,
      ends_at DATETIME NULL,
      capacity INT UNSIGNED NULL,
      payment_mode ENUM('free','manual_transfer','provider') NOT NULL DEFAULT 'free',
      amount_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
      currency CHAR(3) NOT NULL DEFAULT 'IRR',
      settings JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_campaigns_slug(slug),
      KEY idx_campaigns_status(status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS campaign_sequences (
      campaign_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      last_value BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_campaign_sequences_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS campaign_entries (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      campaign_id BIGINT UNSIGNED NOT NULL,
      participant_id BIGINT UNSIGNED NOT NULL,
      legacy_entry_id BIGINT UNSIGNED NULL,
      status ENUM('pending_payment','active','inactive','cancelled','refunded') NOT NULL DEFAULT 'active',
      payment_status ENUM('not_required','pending','approved','rejected','failed','refunded') NOT NULL DEFAULT 'not_required',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_campaign_participant(campaign_id,participant_id),
      UNIQUE KEY uq_campaign_legacy_entry(legacy_entry_id),
      KEY idx_campaign_entries_status(campaign_id,status),
      CONSTRAINT fk_campaign_entries_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
      CONSTRAINT fk_campaign_entries_participant FOREIGN KEY(participant_id) REFERENCES participants(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS issued_codes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      campaign_id BIGINT UNSIGNED NOT NULL,
      entry_id BIGINT UNSIGNED NOT NULL,
      sequence_no BIGINT UNSIGNED NULL,
      code VARCHAR(32) NOT NULL,
      status ENUM('active','revoked') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_issued_codes_entry(entry_id),
      UNIQUE KEY uq_issued_codes_campaign_code(campaign_id,code),
      UNIQUE KEY uq_issued_codes_sequence(campaign_id,sequence_no),
      CONSTRAINT fk_issued_codes_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
      CONSTRAINT fk_issued_codes_entry FOREIGN KEY(entry_id) REFERENCES campaign_entries(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS campaign_payments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      entry_id BIGINT UNSIGNED NOT NULL,
      mode ENUM('manual_transfer','provider') NOT NULL,
      status ENUM('pending','approved','rejected','failed','refunded') NOT NULL DEFAULT 'pending',
      amount_minor BIGINT UNSIGNED NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'IRR',
      provider_reference VARCHAR(160) NULL,
      reviewed_by VARCHAR(80) NULL,
      reviewed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_campaign_payment_provider_ref(mode,provider_reference),
      KEY idx_campaign_payments_entry(entry_id,status),
      CONSTRAINT fk_campaign_payments_entry FOREIGN KEY(entry_id) REFERENCES campaign_entries(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS campaign_payment_proofs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      payment_id BIGINT UNSIGNED NOT NULL,
      storage_key VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      file_size INT UNSIGNED NOT NULL,
      sha256 CHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payment_proof_storage(storage_key),
      CONSTRAINT fk_payment_proofs_payment FOREIGN KEY(payment_id) REFERENCES campaign_payments(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS campaign_draws (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      campaign_id BIGINT UNSIGNED NOT NULL,
      winner_entry_id BIGINT UNSIGNED NOT NULL,
      winner_code VARCHAR(32) NOT NULL,
      drawn_by VARCHAR(80) NOT NULL,
      draw_seed VARCHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_campaign_draw_once(campaign_id),
      CONSTRAINT fk_campaign_draws_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
      CONSTRAINT fk_campaign_draws_entry FOREIGN KEY(winner_entry_id) REFERENCES campaign_entries(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS campaign_draw_participants (
      draw_id BIGINT UNSIGNED NOT NULL,
      entry_id BIGINT UNSIGNED NOT NULL,
      code VARCHAR(32) NOT NULL,
      PRIMARY KEY(draw_id,entry_id),
      UNIQUE KEY uq_campaign_draw_code(draw_id,code),
      CONSTRAINT fk_campaign_draw_participants_draw FOREIGN KEY(draw_id) REFERENCES campaign_draws(id),
      CONSTRAINT fk_campaign_draw_participants_entry FOREIGN KEY(entry_id) REFERENCES campaign_entries(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];
  for (const sql of ddl) await db.query(sql);

  await db.execute(
    `INSERT IGNORE INTO campaigns(slug,title,status,payment_mode)
     VALUES('legacy','کمپین قدیمی iStore','closed','free')`
  );
  const [[campaign]] = await db.execute("SELECT id FROM campaigns WHERE slug='legacy' LIMIT 1");
  await db.execute('INSERT IGNORE INTO campaign_sequences(campaign_id,last_value) VALUES(?,0)', [campaign.id]);

  // Idempotent backfill; preserve every legacy code exactly as it was.
  await db.query(`
    INSERT INTO participants(telegram_user_id,full_name,phone,instagram)
    SELECT e.telegram_user_id,e.full_name,e.phone,e.instagram
    FROM lottery_entries e
    LEFT JOIN participants p ON p.telegram_user_id=e.telegram_user_id
    WHERE p.id IS NULL
  `);
  await db.execute(`
    INSERT IGNORE INTO campaign_entries(campaign_id,participant_id,legacy_entry_id,status,payment_status,created_at)
    SELECT ?,p.id,e.id,
      CASE WHEN e.status='active' THEN 'active' WHEN e.status='deleted' THEN 'cancelled' ELSE 'inactive' END,
      'not_required',e.created_at
    FROM lottery_entries e
    JOIN participants p ON p.telegram_user_id=e.telegram_user_id
  `, [campaign.id]);
  await db.execute(`
    INSERT IGNORE INTO issued_codes(campaign_id,entry_id,code,status,created_at)
    SELECT ?,ce.id,e.raffle_code,
      CASE WHEN e.status='active' THEN 'active' ELSE 'revoked' END,e.created_at
    FROM lottery_entries e
    JOIN campaign_entries ce ON ce.legacy_entry_id=e.id
  `, [campaign.id]);
  const [[seq]] = await db.execute(
    'SELECT COUNT(*) AS total FROM issued_codes WHERE campaign_id=?', [campaign.id]
  );
  await db.execute(
    'UPDATE campaign_sequences SET last_value=? WHERE campaign_id=? AND last_value<?',
    [seq.total, campaign.id, seq.total]
  );
}

module.exports = { migrateMultiCampaign };
