'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

test('schema and migrations upgrade a legacy status enum safely', { skip: !enabled }, async () => {
  const database = 'istore_lottery_migration_test';
  assert.ok(process.env.MYSQL_TEST_USER, 'MYSQL_TEST_USER is required');
  assert.ok(process.env.MYSQL_TEST_PASSWORD, 'MYSQL_TEST_PASSWORD is required');

  const adminDb = await mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD
  });
  try {
    await adminDb.query('DROP DATABASE IF EXISTS `' + database + '`');
    await adminDb.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4');
  } finally {
    await adminDb.end();
  }

  const db = await mysql.createConnection({
      host: process.env.MYSQL_TEST_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER,
      password: process.env.MYSQL_TEST_PASSWORD,
      database,
      multipleStatements: true
    });
    try {
      const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
      await db.query(schema);
      await db.query("ALTER TABLE lottery_entries DROP INDEX uq_entries_active_phone, DROP INDEX uq_entries_active_instagram, DROP COLUMN active_phone, DROP COLUMN active_instagram");
      await db.query("ALTER TABLE lottery_entries MODIFY status ENUM('active','inactive') NOT NULL DEFAULT 'active'");
      await db.execute(
        "INSERT INTO lottery_entries(telegram_user_id,chat_id,full_name,phone,instagram,raffle_code,status) VALUES(?,?,?,?,?,?,'active')",
        ['7000000001','7000000001','Legacy Test User','+989120000001','legacy_test_user','LOT-LEGACY1']
      );
    } finally {
      await db.end();
    }

    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'migrations', 'run.js')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_HOST: process.env.MYSQL_TEST_HOST,
        DB_PORT: String(process.env.MYSQL_TEST_PORT || 3306),
        DB_USER: process.env.MYSQL_TEST_USER,
        DB_PASSWORD: process.env.MYSQL_TEST_PASSWORD,
        DB_NAME: database
      },
      timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /MIGRATIONS_OK/);

    const verify = await mysql.createConnection({
      host: process.env.MYSQL_TEST_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER,
      password: process.env.MYSQL_TEST_PASSWORD,
      database
    });
    try {
      const [[status]] = await verify.execute(
        "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lottery_entries' AND COLUMN_NAME='status'"
      );
      assert.match(status.COLUMN_TYPE, /'deleted'/);
      const [columns] = await verify.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lottery_entries'"
      );
      const names = new Set(columns.map(x => x.COLUMN_NAME));
      assert.ok(names.has('deleted_at'));
      assert.ok(names.has('deletion_reason'));
      const [audit] = await verify.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_audit_log'"
      );
      assert.deepEqual(new Set(audit.map(x => x.COLUMN_NAME)), new Set([
        'id', 'admin_id', 'action', 'entity_type', 'entity_id', 'details', 'created_at'
      ]));
      const [campaignRows] = await verify.execute("SELECT id FROM campaigns WHERE slug='legacy-lottery' LIMIT 1");
      assert.equal(campaignRows.length, 1);
      const [cardTables] = await verify.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('bank_cards','campaign_payment_card_history','payment_order_card_deliveries')");
      assert.deepEqual(new Set(cardTables.map(x => x.TABLE_NAME)), new Set(['bank_cards','campaign_payment_card_history','payment_order_card_deliveries']));
      const [accountTables] = await verify.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('account_telegram_links','web_accounts','password_reset_requests','account_reset_tokens')");
      assert.deepEqual(new Set(accountTables.map(x => x.TABLE_NAME)), new Set(['account_telegram_links','web_accounts','password_reset_requests','account_reset_tokens']));
      const [contactGateTables] = await verify.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_contact_gate'");
      assert.deepEqual(contactGateTables.map(x => x.TABLE_NAME), ['telegram_contact_gate']);
      const [customerFlowTables] = await verify.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets'");
      assert.deepEqual(customerFlowTables.map(x => x.TABLE_NAME), ['customer_support_tickets']);
      const [[sessionStepColumn]] = await verify.execute("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='lottery_sessions' AND COLUMN_NAME='step'");
      assert.match(sessionStepColumn.COLUMN_TYPE, /'profile_name'/);
      assert.match(sessionStepColumn.COLUMN_TYPE, /'support_message'/);
      const [campaignCardColumn] = await verify.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaigns' AND COLUMN_NAME='current_payment_card_id'");
      assert.equal(campaignCardColumn.length, 1);
      const [mappingRows] = await verify.execute(
        "SELECT p.telegram_user_id,ce.status,cc.code FROM legacy_entry_mappings m JOIN participants p ON p.id=m.participant_id JOIN campaign_entries ce ON ce.id=m.campaign_entry_id JOIN campaign_codes cc ON cc.id=m.campaign_code_id WHERE p.telegram_user_id='7000000001'"
      );
      assert.equal(mappingRows.length, 1);
      assert.equal(String(mappingRows[0].telegram_user_id), '7000000001');
      assert.equal(mappingRows[0].status, 'active');
      assert.equal(mappingRows[0].code, 'LOT-LEGACY1');
      const [legacyRows] = await verify.execute("SELECT COUNT(*) AS total FROM lottery_entries WHERE telegram_user_id='7000000001'");
      assert.equal(Number(legacyRows[0].total), 1, 'legacy row must remain untouched');
    } finally {
      await verify.end();
    }
});
