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
      max_codes_per_participant INT UNSIGNED NULL DEFAULT 1,
      currency CHAR(3) NOT NULL DEFAULT 'IRR',
      settings JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_campaigns_slug(slug),
      KEY idx_campaigns_status(status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS campaign_sequences (
      campaign_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
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
      quantity INT UNSIGNED NOT NULL DEFAULT 1,
      currency CHAR(3) NOT NULL DEFAULT 'IRR',
      provider_reference VARCHAR(160) NULL,
      reviewed_by VARCHAR(80) NULL,
      reviewed_at DATETIME NULL,
      telegram_chat_id VARCHAR(80) NULL,
      business_connection_id VARCHAR(255) NULL,
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
      sha256 CHAR(64) NULL,
      telegram_file_id VARCHAR(255) NULL,
      telegram_file_unique_id VARCHAR(255) NULL,
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
      PRIMARY KEY(draw_id,code),
      KEY idx_campaign_draw_entry(draw_id,entry_id),
      CONSTRAINT fk_campaign_draw_participants_draw FOREIGN KEY(draw_id) REFERENCES campaign_draws(id),
      CONSTRAINT fk_campaign_draw_participants_entry FOREIGN KEY(entry_id) REFERENCES campaign_entries(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];
  for (const sql of ddl) await db.query(sql);
  const [campaignColumns] = await db.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaigns'"
  );
  if (!campaignColumns.some(column => column.COLUMN_NAME === 'max_codes_per_participant')) {
    await db.query('ALTER TABLE campaigns ADD COLUMN max_codes_per_participant INT UNSIGNED NULL DEFAULT 1 AFTER amount_minor');
  }
  const [paymentSchemaColumns] = await db.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_payments'"
  );
  if (!paymentSchemaColumns.some(column => column.COLUMN_NAME === 'quantity')) {
    await db.query('ALTER TABLE campaign_payments ADD COLUMN quantity INT UNSIGNED NOT NULL DEFAULT 1 AFTER amount_minor');
  }
  if (!paymentSchemaColumns.some(column => column.COLUMN_NAME === 'telegram_chat_id')) {
    await db.query('ALTER TABLE campaign_payments ADD COLUMN telegram_chat_id VARCHAR(80) NULL AFTER reviewed_at');
  }
  if (!paymentSchemaColumns.some(column => column.COLUMN_NAME === 'business_connection_id')) {
    await db.query('ALTER TABLE campaign_payments ADD COLUMN business_connection_id VARCHAR(255) NULL AFTER telegram_chat_id');
  }
  const [codeIndexes] = await db.execute(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='issued_codes' AND INDEX_NAME='uq_issued_codes_entry'"
  );
  if (codeIndexes.length) await db.query('ALTER TABLE issued_codes DROP INDEX uq_issued_codes_entry');

  const [drawParticipantIndexes] = await db.execute(
    "SELECT INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_draw_participants' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX"
  );
  if (drawParticipantIndexes.length === 2 && drawParticipantIndexes[1].COLUMN_NAME === 'entry_id') {
    await db.query('ALTER TABLE campaign_draw_participants DROP PRIMARY KEY, DROP INDEX uq_campaign_draw_code, ADD PRIMARY KEY(draw_id,code), ADD KEY idx_campaign_draw_entry(draw_id,entry_id)');
  }

  const [sessionColumns] = await db.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lottery_sessions'"
  );
  if (!sessionColumns.some(column => column.COLUMN_NAME === 'campaign_id')) {
    await db.query('ALTER TABLE lottery_sessions ADD COLUMN campaign_id BIGINT UNSIGNED NULL AFTER telegram_user_id');
    await db.query('ALTER TABLE lottery_sessions ADD KEY idx_lottery_sessions_campaign(campaign_id)');
  }

  const [[legacyDuplicateInstagram]] = await db.query(
    "SELECT LOWER(TRIM(LEADING '@' FROM instagram)) instagram,COUNT(*) total FROM lottery_entries GROUP BY LOWER(TRIM(LEADING '@' FROM instagram)) HAVING COUNT(*)>1 LIMIT 1"
  );
  if (legacyDuplicateInstagram) {
    throw new Error('Legacy lottery_entries contains duplicate Instagram ID "' + legacyDuplicateInstagram.instagram + '". Resolve duplicate profiles before migrating.');
  }
  const [[normalizedDuplicateInstagram]] = await db.query(
    "SELECT LOWER(TRIM(LEADING '@' FROM instagram)) instagram,COUNT(*) total FROM participants GROUP BY LOWER(TRIM(LEADING '@' FROM instagram)) HAVING COUNT(*)>1 LIMIT 1"
  );
  if (normalizedDuplicateInstagram) {
    throw new Error('Participant profiles contain duplicate Instagram ID "' + normalizedDuplicateInstagram.instagram + '". Resolve duplicates before migration.');
  }
  await db.query("UPDATE participants SET instagram=LOWER(TRIM(LEADING '@' FROM instagram))");
  const [[duplicateInstagram]] = await db.query(
    "SELECT instagram,COUNT(*) total FROM participants GROUP BY instagram HAVING COUNT(*)>1 LIMIT 1"
  );
  if (duplicateInstagram) {
    throw new Error('Cannot enforce unique participant Instagram: duplicate value "' + duplicateInstagram.instagram + '" exists in participants. Resolve duplicates before migration.');
  }
  const [participantIndexes] = await db.execute(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='participants' AND INDEX_NAME='uq_participants_instagram'"
  );
  if (!participantIndexes.length) await db.query('ALTER TABLE participants ADD UNIQUE KEY uq_participants_instagram(instagram)');

  const [paymentColumns] = await db.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_payments'"
  );
  if (!paymentColumns.some(column => column.COLUMN_NAME === 'telegram_chat_id')) {
    await db.query('ALTER TABLE campaign_payments ADD COLUMN telegram_chat_id VARCHAR(80) NULL AFTER reviewed_at');
    await db.query('ALTER TABLE campaign_payments ADD COLUMN business_connection_id VARCHAR(255) NULL AFTER telegram_chat_id');
  }
  const [proofColumns] = await db.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_payment_proofs'"
  );
  if (!proofColumns.some(column => column.COLUMN_NAME === 'telegram_file_id')) {
    await db.query('ALTER TABLE campaign_payment_proofs ADD COLUMN telegram_file_id VARCHAR(255) NULL AFTER storage_key');
  }
  const [proofUniqueColumns] = await db.execute(
    "SELECT COLUMN_NAME,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_payment_proofs'"
  );
  if (proofUniqueColumns.some(column => column.COLUMN_NAME === 'sha256' && column.IS_NULLABLE === 'NO')) {
    await db.query('ALTER TABLE campaign_payment_proofs MODIFY sha256 CHAR(64) NULL');
  }
  if (!proofUniqueColumns.some(column => column.COLUMN_NAME === 'telegram_file_unique_id')) {
    await db.query('ALTER TABLE campaign_payment_proofs ADD COLUMN telegram_file_unique_id VARCHAR(255) NULL AFTER telegram_file_id');
  }

  const [proofIndexes] = await db.execute(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_payment_proofs' AND INDEX_NAME='uq_payment_proof_payment'"
  );
  if (!proofIndexes.length) await db.query('ALTER TABLE campaign_payment_proofs ADD UNIQUE KEY uq_payment_proof_payment(payment_id)');

  await db.execute(
    `INSERT IGNORE INTO campaigns(slug,title,status,payment_mode)
     VALUES('legacy','کمپین قدیمی iStore','closed','free')`
  );
  const [[campaign]] = await db.execute("SELECT id FROM campaigns WHERE slug='legacy' LIMIT 1");
  await db.execute('INSERT IGNORE INTO campaign_sequences(campaign_id,last_sequence) VALUES(?,0)', [campaign.id]);

  // Idempotent backfill; preserve every legacy code exactly as it was.
  await db.query(`
    INSERT INTO participants(telegram_user_id,full_name,phone,instagram)
    SELECT e.telegram_user_id,e.full_name,e.phone,LOWER(TRIM(LEADING '@' FROM e.instagram))
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
    'UPDATE campaign_sequences SET last_sequence=? WHERE campaign_id=? AND last_sequence<?',
    [seq.total, campaign.id, seq.total]
  );
}

module.exports = { migrateMultiCampaign };
