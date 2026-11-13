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
        [987654321,987654321,'Legacy Participant','09123456789','legacy_user','LOT-LEGACY1']
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
      const [[legacyCampaign]] = await verify.execute("SELECT id,status FROM campaigns WHERE slug='legacy'");
      assert.ok(legacyCampaign, 'legacy campaign must be created');
      assert.equal(legacyCampaign.status, 'closed');
      const [[participant]] = await verify.execute("SELECT id,telegram_user_id,full_name FROM participants WHERE telegram_user_id=987654321");
      assert.ok(participant, 'legacy participant profile must be backfilled');
      assert.equal(participant.full_name, 'Legacy Participant');
      const [[entry]] = await verify.execute(
        "SELECT id,campaign_id,status FROM campaign_entries WHERE legacy_entry_id=(SELECT id FROM lottery_entries WHERE telegram_user_id=987654321)"
      );
      assert.ok(entry, 'legacy campaign entry must be backfilled');
      assert.equal(entry.campaign_id, legacyCampaign.id);
      assert.equal(entry.status, 'active');
      const [[issued]] = await verify.execute("SELECT code,status FROM issued_codes WHERE entry_id=?", [entry.id]);
      assert.deepEqual(issued, { code: 'LOT-LEGACY1', status: 'active' });
      const [[sequenceBefore]] = await verify.execute("SELECT last_sequence FROM campaign_sequences WHERE campaign_id=?", [legacyCampaign.id]);
      assert.equal(Number(sequenceBefore.last_sequence), 1);
      const [audit] = await verify.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_audit_log'"
      );
      assert.deepEqual(new Set(audit.map(x => x.COLUMN_NAME)), new Set([
        'id', 'admin_id', 'action', 'entity_type', 'entity_id', 'details', 'created_at'
      ]));
      const secondRun = spawnSync(process.execPath, [path.join(__dirname, '..', 'migrations', 'run.js')], {
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
      assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
      const idempotency = await mysql.createConnection({
        host: process.env.MYSQL_TEST_HOST,
        port: Number(process.env.MYSQL_TEST_PORT || 3306),
        user: process.env.MYSQL_TEST_USER,
        password: process.env.MYSQL_TEST_PASSWORD,
        database
      });
      try {
        const { joinCampaign } = require('../src/campaign-service');
        const [campaignResult] = await idempotency.execute(
          "INSERT INTO campaigns(slug,title,status,capacity,payment_mode) VALUES('integration-capacity','Integration Capacity','active',1,'free')"
        );
        const pool = mysql.createPool({
          host: process.env.MYSQL_TEST_HOST,
          port: Number(process.env.MYSQL_TEST_PORT || 3306),
          user: process.env.MYSQL_TEST_USER,
          password: process.env.MYSQL_TEST_PASSWORD,
          database,
          connectionLimit: 3
        });
        try {
          const args = {
            db: pool,
            telegramUserId: '987654322',
            fullName: 'Campaign Participant',
            phone: '09123456780',
            instagram: 'campaign_user',
            chatId: '987654322',
            campaignSlug: 'integration-capacity',
            codeSecret: 'integration-test-secret-at-least-32-characters'
          };
          const firstJoin = await joinCampaign(args);
          assert.equal(firstJoin.status, 'active');
          assert.match(firstJoin.code, /^IS-[A-F0-9]{24}$/);
          const repeatJoin = await joinCampaign(args);
          assert.equal(repeatJoin.existing, true);
          assert.equal(repeatJoin.code, firstJoin.code);
          await assert.rejects(
            joinCampaign({ ...args, telegramUserId: '987654323', fullName: 'Duplicate Identity', instagram: 'different_user', chatId: '987654323' }),
            error => error.code === 'DUPLICATE_CONTACT'
          );
          await assert.rejects(
            joinCampaign({ ...args, telegramUserId: '987654324', fullName: 'Duplicate Instagram', phone: '09123456782', instagram: '@CAMPAIGN_USER', chatId: '987654324' }),
            error => error.code === 'DUPLICATE_CONTACT'
          );
          await assert.rejects(
            joinCampaign({ ...args, telegramUserId: '987654326', fullName: 'Invalid Participant', phone: 'not-a-phone', instagram: 'invalid_user', chatId: '987654326' }),
            error => error.code === 'INVALID_PARTICIPANT_PROFILE'
          );
          await assert.rejects(
            joinCampaign({ ...args, telegramUserId: '987654325', fullName: 'Second Participant', phone: '09123456781', instagram: 'second_user', chatId: '987654325' }),
            error => error.code === 'CAMPAIGN_FULL'
          );
          const [[issuedCount]] = await idempotency.execute(
            "SELECT COUNT(*) AS total FROM issued_codes WHERE campaign_id=?",
            [campaignResult.insertId]
          );
          assert.equal(Number(issuedCount.total), 1);

          const { approveManualPayment } = require('../src/campaign-service');
          await idempotency.execute(
            "INSERT INTO campaigns(slug,title,status,capacity,payment_mode,amount_minor,settings) VALUES('integration-manual','Manual Transfer','active',10,'manual_transfer',250000,JSON_OBJECT('card_number','1234567812345678','card_holder','Test Owner'))"
          );
          const manualArgs = { ...args, telegramUserId: '987654327', fullName: 'Manual Transfer User', phone: '09123456783', instagram: '@manual_user', chatId: '987654327', campaignSlug: 'integration-manual' };
          const pending = await joinCampaign(manualArgs);
          assert.equal(pending.status, 'pending_payment');
          assert.equal(pending.paymentStatus, 'pending');
          assert.equal(pending.code, null);
          await assert.rejects(
            approveManualPayment({ db: pool, paymentId: pending.paymentId, reviewer: 'admin', codeSecret: args.codeSecret }),
            error => error.code === 'PAYMENT_PROOF_REQUIRED'
          );
          await idempotency.execute(
            "INSERT INTO campaign_payment_proofs(payment_id,storage_key,mime_type,file_size,sha256,telegram_file_id) VALUES(?,?,?,?,?,?)",
            [pending.paymentId, 'telegram:test-file', 'image/jpeg', 100, 'a'.repeat(64), 'test-file']
          );
          const approved = await approveManualPayment({ db: pool, paymentId: pending.paymentId, reviewer: 'admin', codeSecret: args.codeSecret });
          assert.equal(approved.approved, true);
          assert.match(approved.code, /^IS-[A-F0-9]{24}$/);
        } finally {
          await pool.end();
        }
        const [[counts]] = await idempotency.execute(
          "SELECT (SELECT COUNT(*) FROM participants WHERE telegram_user_id=987654321) AS profiles, (SELECT COUNT(*) FROM campaign_entries WHERE legacy_entry_id=(SELECT id FROM lottery_entries WHERE telegram_user_id=987654321)) AS entries, (SELECT COUNT(*) FROM issued_codes WHERE code='LOT-LEGACY1') AS codes"
        );
        assert.deepEqual(
          { profiles: Number(counts.profiles), entries: Number(counts.entries), codes: Number(counts.codes) },
          { profiles: 1, entries: 1, codes: 1 }
        );
      } finally {
        await idempotency.end();
      }
    } finally {
      await verify.end();
    }
});
