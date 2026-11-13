'use strict';

const CAMPAIGN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS participants (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    chat_id BIGINT NULL,
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(25) NOT NULL,
    instagram VARCHAR(40) NOT NULL,
    status ENUM('active','inactive','deleted') NOT NULL DEFAULT 'active',
    active_phone VARCHAR(25) GENERATED ALWAYS AS (CASE WHEN status='active' THEN phone ELSE NULL END) STORED,
    active_instagram VARCHAR(40) GENERATED ALWAYS AS (CASE WHEN status='active' THEN LOWER(instagram) ELSE NULL END) STORED,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_participants_telegram(telegram_user_id),
    UNIQUE KEY uq_participants_active_phone(active_phone),
    UNIQUE KEY uq_participants_active_instagram(active_instagram),
    KEY idx_participants_phone(phone),
    KEY idx_participants_instagram(instagram)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS campaigns (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(80) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    status ENUM('draft','scheduled','open','paused','closed','drawn','archived') NOT NULL DEFAULT 'draft',
    payment_mode ENUM('free','manual','gateway') NOT NULL DEFAULT 'free',
    price_per_code DECIMAL(18,2) NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'IRR',
    max_participants INT UNSIGNED NULL,
    max_codes INT UNSIGNED NULL,
    max_codes_per_participant INT UNSIGNED NOT NULL DEFAULT 1,
    draw_basis ENUM('per_code','per_participant') NOT NULL DEFAULT 'per_code',
    winner_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    alternate_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    multiple_win_policy ENUM('one_per_participant','allow') NOT NULL DEFAULT 'one_per_participant',
    draw_method ENUM('system','live_wheel','hybrid') NOT NULL DEFAULT 'system',
    starts_at DATETIME NULL,
    ends_at DATETIME NULL,
    terms_version VARCHAR(40) NOT NULL DEFAULT '1',
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_campaign_slug(slug),
    KEY idx_campaign_status_dates(status,starts_at,ends_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS campaign_status_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    from_status VARCHAR(20) NULL,
    to_status VARCHAR(20) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    reason VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_campaign_status_history(campaign_id,created_at),
    CONSTRAINT fk_campaign_status_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS campaign_entries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    status ENUM('pending','active','inactive','cancelled','disqualified') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_campaign_participant(campaign_id,participant_id),
    KEY idx_campaign_entries_status(campaign_id,status),
    CONSTRAINT fk_campaign_entry_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT,
    CONSTRAINT fk_campaign_entry_participant FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS campaign_codes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    entry_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    code VARCHAR(32) NOT NULL,
    status ENUM('active','voided') NOT NULL DEFAULT 'active',
    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at TIMESTAMP NULL,
    void_reason VARCHAR(255) NULL,
    UNIQUE KEY uq_campaign_code_value(code),
    KEY idx_campaign_codes_entry(entry_id,status),
    KEY idx_campaign_codes_campaign(campaign_id,status),
    CONSTRAINT fk_campaign_code_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT,
    CONSTRAINT fk_campaign_code_entry FOREIGN KEY(entry_id) REFERENCES campaign_entries(id) ON DELETE RESTRICT,
    CONSTRAINT fk_campaign_code_participant FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS campaign_code_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_code_id BIGINT UNSIGNED NOT NULL,
    code VARCHAR(32) NOT NULL,
    action ENUM('issued','voided') NOT NULL,
    actor VARCHAR(64) NOT NULL,
    reason VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_campaign_code_history(campaign_code_id,created_at),
    CONSTRAINT fk_campaign_code_history_code FOREIGN KEY(campaign_code_id) REFERENCES campaign_codes(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_ref VARCHAR(40) NOT NULL,
    campaign_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    entry_id BIGINT UNSIGNED NOT NULL,
    quantity SMALLINT UNSIGNED NOT NULL,
    unit_price_snapshot DECIMAL(18,2) NOT NULL,
    total_snapshot DECIMAL(18,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    terms_snapshot JSON NOT NULL,
    status ENUM('pending_payment','receipt_submitted','approved','rejected','expired','cancelled') NOT NULL DEFAULT 'pending_payment',
    expires_at DATETIME NULL,
    reviewed_by VARCHAR(64) NULL,
    reviewed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_payment_order_ref(order_ref),
    KEY idx_payment_order_campaign(campaign_id,status,expires_at),
    CONSTRAINT fk_payment_order_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT,
    CONSTRAINT fk_payment_order_participant FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE RESTRICT,
    CONSTRAINT fk_payment_order_entry FOREIGN KEY(entry_id) REFERENCES campaign_entries(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_receipts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNSIGNED NOT NULL,
    telegram_file_id VARCHAR(255) NOT NULL,
    telegram_file_unique_id VARCHAR(255) NULL,
    declared_tracking_ref VARCHAR(100) NULL,
    submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    review_status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(64) NULL,
    reviewed_at DATETIME NULL,
    review_note VARCHAR(255) NULL,
    KEY idx_payment_receipt_order(order_id,submitted_at),
    CONSTRAINT fk_payment_receipt_order FOREIGN KEY(order_id) REFERENCES payment_orders(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS payment_transactions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNSIGNED NOT NULL,
    provider VARCHAR(32) NOT NULL DEFAULT 'manual',
    provider_reference VARCHAR(100) NULL,
    amount DECIMAL(18,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    status ENUM('pending','confirmed','rejected','refunded') NOT NULL,
    verified_by VARCHAR(64) NOT NULL,
    verified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_payment_transaction_order(order_id),
    CONSTRAINT fk_payment_transaction_order FOREIGN KEY(order_id) REFERENCES payment_orders(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS campaign_capacity_reservations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    order_id BIGINT UNSIGNED NOT NULL,
    participant_slots TINYINT UNSIGNED NOT NULL DEFAULT 1,
    code_slots SMALLINT UNSIGNED NOT NULL,
    status ENUM('held','committed','released','expired') NOT NULL DEFAULT 'held',
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_capacity_order(order_id),
    KEY idx_capacity_campaign(campaign_id,status,expires_at),
    CONSTRAINT fk_capacity_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT,
    CONSTRAINT fk_capacity_participant FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE RESTRICT,
    CONSTRAINT fk_capacity_order FOREIGN KEY(order_id) REFERENCES payment_orders(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS profile_change_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    participant_id BIGINT UNSIGNED NOT NULL,
    field_name ENUM('full_name','phone','instagram') NOT NULL,
    old_value VARCHAR(150) NOT NULL,
    requested_value VARCHAR(150) NOT NULL,
    status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(64) NULL,
    reviewed_at DATETIME NULL,
    review_note VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_profile_change_status(status,created_at),
    CONSTRAINT fk_profile_change_participant FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS campaign_draws (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    draw_number INT UNSIGNED NOT NULL,
    method ENUM('system','live_wheel','hybrid') NOT NULL,
    status ENUM('prepared','running','pending_approval','completed','cancelled') NOT NULL DEFAULT 'prepared',
    draw_basis ENUM('per_code','per_participant') NOT NULL,
    multiple_win_policy ENUM('one_per_participant','allow') NOT NULL DEFAULT 'one_per_participant',
    winner_count SMALLINT UNSIGNED NOT NULL,
    alternate_count SMALLINT UNSIGNED NOT NULL,
    snapshot_hash CHAR(64) NULL,
    algorithm_version VARCHAR(40) NOT NULL,
    seed_commitment CHAR(64) NULL,
    external_reference VARCHAR(255) NULL,
    created_by VARCHAR(64) NOT NULL,
    approved_by VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    UNIQUE KEY uq_campaign_draw_number(campaign_id,draw_number),
    KEY idx_campaign_draw_status(campaign_id,status),
    CONSTRAINT fk_campaign_draw_campaign FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS draw_candidates (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    draw_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    code VARCHAR(32) NULL,
    candidate_reference VARCHAR(100) NOT NULL,
    eligibility ENUM('eligible','excluded') NOT NULL DEFAULT 'eligible',
    exclusion_reason VARCHAR(255) NULL,
    UNIQUE KEY uq_draw_candidate(draw_id,candidate_reference),
    KEY idx_draw_candidates(draw_id,eligibility),
    CONSTRAINT fk_draw_candidate_draw FOREIGN KEY(draw_id) REFERENCES campaign_draws(id) ON DELETE RESTRICT,
    CONSTRAINT fk_draw_candidate_participant FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS draw_winners (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    draw_id BIGINT UNSIGNED NOT NULL,
    candidate_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    code VARCHAR(32) NULL,
    winner_rank SMALLINT UNSIGNED NOT NULL,
    winner_type ENUM('primary','alternate') NOT NULL,
    selection_method ENUM('system','live_wheel','hybrid') NOT NULL,
    external_reference VARCHAR(255) NULL,
    approved_by VARCHAR(64) NULL,
    approved_at DATETIME NULL,
    UNIQUE KEY uq_draw_winner_rank(draw_id,winner_rank),
    KEY idx_draw_winners_participant(draw_id,participant_id),
    CONSTRAINT fk_draw_winner_draw FOREIGN KEY(draw_id) REFERENCES campaign_draws(id) ON DELETE RESTRICT,
    CONSTRAINT fk_draw_winner_candidate FOREIGN KEY(candidate_id) REFERENCES draw_candidates(id) ON DELETE RESTRICT,
    CONSTRAINT fk_draw_winner_participant FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS draw_evidence (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    draw_id BIGINT UNSIGNED NOT NULL,
    evidence_type VARCHAR(40) NOT NULL,
    reference_uri VARCHAR(500) NULL,
    content_hash CHAR(64) NULL,
    description VARCHAR(500) NULL,
    recorded_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_draw_evidence(draw_id,created_at),
    CONSTRAINT fk_draw_evidence_draw FOREIGN KEY(draw_id) REFERENCES campaign_draws(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL,
    operation VARCHAR(64) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    resource_type VARCHAR(64) NULL,
    resource_id VARCHAR(64) NULL,
    result JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_idempotency_key(idempotency_key),
    KEY idx_idempotency_actor(actor,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS legacy_entry_mappings (
    legacy_entry_id BIGINT UNSIGNED PRIMARY KEY,
    participant_id BIGINT UNSIGNED NOT NULL,
    campaign_entry_id BIGINT UNSIGNED NOT NULL,
    campaign_code_id BIGINT UNSIGNED NOT NULL,
    migrated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_legacy_campaign_entry(campaign_entry_id),
    CONSTRAINT fk_legacy_participant FOREIGN KEY(participant_id) REFERENCES participants(id) ON DELETE RESTRICT,
    CONSTRAINT fk_legacy_campaign_entry FOREIGN KEY(campaign_entry_id) REFERENCES campaign_entries(id) ON DELETE RESTRICT,
    CONSTRAINT fk_legacy_campaign_code FOREIGN KEY(campaign_code_id) REFERENCES campaign_codes(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function tableExists(db, table) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1',
    [table]
  );
  return rows.length > 0;
}

async function migrateLegacyEntries(db) {
  const [legacy] = await db.query(
    'SELECT id,telegram_user_id,chat_id,full_name,phone,instagram,raffle_code,status,created_at,updated_at FROM lottery_entries ORDER BY id'
  );
  if (!legacy.length) return { migrated: 0 };

  const [[campaign]] = await db.execute(
    "SELECT id FROM campaigns WHERE slug='legacy-lottery' LIMIT 1"
  );
  let campaignId = campaign?.id;
  if (!campaignId) {
    const [created] = await db.execute(
      "INSERT INTO campaigns(slug,name,description,status,payment_mode,price_per_code,max_codes_per_participant,draw_basis,winner_count,created_by) VALUES('legacy-lottery','کمپین قدیمی','مهاجرت خودکار از سیستم تک‌کمپینی','closed','free',0,1,'per_code',1,'migration')"
    );
    campaignId = created.insertId;
  }

  let migrated = 0;
  for (const row of legacy) {
    const [[mapping]] = await db.execute(
      'SELECT legacy_entry_id FROM legacy_entry_mappings WHERE legacy_entry_id=?',
      [row.id]
    );
    if (mapping) continue;

    const [pRows] = await db.execute(
      'SELECT id FROM participants WHERE telegram_user_id=? LIMIT 1',
      [String(row.telegram_user_id)]
    );
    let participantId = pRows[0]?.id;
    if (!participantId) {
      const [p] = await db.execute(
        'INSERT INTO participants(telegram_user_id,chat_id,full_name,phone,instagram,status,created_at) VALUES(?,?,?,?,?,?,?)',
        [String(row.telegram_user_id), String(row.chat_id), row.full_name, row.phone, row.instagram, row.status === 'deleted' ? 'deleted' : row.status, row.created_at]
      );
      participantId = p.insertId;
    }

    const [entryRows] = await db.execute(
      'SELECT id FROM campaign_entries WHERE campaign_id=? AND participant_id=? LIMIT 1',
      [campaignId, participantId]
    );
    let entryId = entryRows[0]?.id;
    if (!entryId) {
      const [entry] = await db.execute(
        'INSERT INTO campaign_entries(campaign_id,participant_id,status,created_at,updated_at) VALUES(?,?,?,?,?)',
        [campaignId, participantId, row.status === 'active' ? 'active' : row.status === 'deleted' ? 'disqualified' : 'inactive', row.created_at, row.updated_at || row.created_at]
      );
      entryId = entry.insertId;
    }

    const [codeRows] = await db.execute(
      'SELECT id FROM campaign_codes WHERE code=? LIMIT 1',
      [row.raffle_code]
    );
    let codeId = codeRows[0]?.id;
    if (!codeId) {
      const [createdCode] = await db.execute(
        'INSERT INTO campaign_codes(campaign_id,entry_id,participant_id,code,status,issued_at) VALUES(?,?,?,?,?,?)',
        [campaignId, entryId, participantId, row.raffle_code, row.status === 'active' ? 'active' : 'voided', row.created_at]
      );
      codeId = createdCode.insertId;
      await db.execute(
        "INSERT INTO campaign_code_history(campaign_code_id,code,action,actor,reason,created_at) VALUES(?,?,'issued','migration','legacy code preserved',?)",
        [codeId, row.raffle_code, row.created_at]
      );
      if (row.status !== 'active') {
        await db.execute(
          "INSERT INTO campaign_code_history(campaign_code_id,code,action,actor,reason,created_at) VALUES(?,?,'voided','migration','legacy entry not active',?)",
          [codeId, row.raffle_code, row.updated_at || row.created_at]
        );
      }
    }

    await db.execute(
      'INSERT INTO legacy_entry_mappings(legacy_entry_id,participant_id,campaign_entry_id,campaign_code_id) VALUES(?,?,?,?)',
      [row.id, participantId, entryId, codeId]
    );
    migrated++;
  }
  return { migrated, campaignId };
}

async function up(db) {
  if (!(await tableExists(db, 'lottery_entries'))) {
    throw new Error('Cannot migrate multi-campaign schema: lottery_entries is missing.');
  }
  for (const sql of CAMPAIGN_SCHEMA) await db.query(sql);
  const result = await migrateLegacyEntries(db);
  return result;
}

module.exports = { up, CAMPAIGN_SCHEMA, migrateLegacyEntries };
