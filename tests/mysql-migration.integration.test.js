'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

test('fresh database bootstrap creates only the normalized multi-campaign schema', { skip: !enabled }, async () => {
  const database = 'ustore_fresh_schema_test';
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
    await adminDb.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  } finally { await adminDb.end(); }

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
    timeout: 60000
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /MIGRATIONS_OK/);

  const rerun = spawnSync(process.execPath, [path.join(__dirname, '..', 'migrations', 'run.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_HOST: process.env.MYSQL_TEST_HOST,
      DB_PORT: String(process.env.MYSQL_TEST_PORT || 3306),
      DB_USER: process.env.MYSQL_TEST_USER,
      DB_PASSWORD: process.env.MYSQL_TEST_PASSWORD,
      DB_NAME: database
    },
    timeout: 60000
  });
  assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
  assert.match(rerun.stdout, /MIGRATIONS_OK/);

  const verify = await mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD,
    database
  });
  try {
    const [tables] = await verify.execute(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'
    );
    const names = new Set(tables.map(x => x.TABLE_NAME));
    for (const name of [
      'participants','campaigns','campaign_entries','campaign_codes','payment_orders',
      'payment_receipts','payment_transactions','campaign_capacity_reservations',
      'campaign_payment_sessions','campaign_draws','draw_candidates','draw_winners',
      'draw_evidence','telegram_sessions','telegram_notification_outbox','webhook_inbox',
      'admin_audit_log','processed_updates','customer_support_tickets','bank_cards','web_accounts',
      'password_reset_requests','account_reset_tokens','telegram_contact_gate','customer_support_messages'
    ]) assert.ok(names.has(name), 'missing normalized table: ' + name);
    for (const name of [
      'lottery_entries','lottery_settings','lottery_draws','lottery_draw_participants',
      'lottery_code_history','released_codes','legacy_entry_mappings','lottery_sessions'
    ]) assert.equal(names.has(name), false, 'legacy table must not be created: ' + name);

    const [[campaignColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaigns' AND COLUMN_NAME='current_payment_card_id'"
    );
    assert.equal(Number(campaignColumns.total), 1);
    const [[sessionColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_sessions' AND COLUMN_NAME='step'"
    );
    assert.equal(Number(sessionColumns.total), 1);
    const [[ticketColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' AND COLUMN_NAME='status'"
    );
    assert.equal(Number(ticketColumns.total), 1);
    const [[ticketMessageColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' AND COLUMN_NAME='telegram_message_id'"
    );
    assert.equal(Number(ticketMessageColumns.total), 1);
    const [[ticketMessageIndexes]] = await verify.execute(
      "SELECT COUNT(DISTINCT INDEX_NAME) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_tickets' AND INDEX_NAME='uq_support_telegram_message'"
    );
    assert.equal(Number(ticketMessageIndexes.total), 1);
    const [[supportMessages]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_messages' AND COLUMN_NAME='ticket_id'"
    );
    assert.equal(Number(supportMessages.total), 1);
    const [[deliveryOutboxColumn]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_order_card_deliveries' AND COLUMN_NAME='outbox_id'"
    );
    assert.equal(Number(deliveryOutboxColumn.total), 1);
    const [[deliveryOutboxIndex]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_order_card_deliveries' AND INDEX_NAME='uq_card_delivery_outbox'"
    );
    assert.equal(Number(deliveryOutboxIndex.total), 1);
    const [[profileMessageColumns]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='profile_change_requests' AND COLUMN_NAME='telegram_message_id'"
    );
    assert.equal(Number(profileMessageColumns.total), 1);
    const [[profileMessageIndexes]] = await verify.execute(
      "SELECT COUNT(DISTINCT INDEX_NAME) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='profile_change_requests' AND INDEX_NAME='uq_profile_change_telegram_message'"
    );
    assert.equal(Number(profileMessageIndexes.total), 1);

    // Exercise support-thread backfill and migration idempotency on real MySQL.
    const [ticketInsert] = await verify.execute(
      "INSERT INTO customer_support_tickets(telegram_user_id,chat_id,message,telegram_message_id) VALUES(?,?,?,?)",
      [910001,910001,'Integration support message',910001]
    );
    const supportMigration = require('../migrations/support-threads');
    await supportMigration.up(verify);
    await supportMigration.up(verify);
    const [threadRows] = await verify.execute(
      "SELECT sender_type,sender_id,message,telegram_message_id FROM customer_support_messages WHERE ticket_id=?",
      [ticketInsert.insertId]
    );
    assert.equal(threadRows.length, 1, 'support migration must backfill exactly once');
    assert.equal(threadRows[0].sender_type, 'customer');
    assert.equal(threadRows[0].message, 'Integration support message');
    await assert.rejects(
      verify.execute("INSERT INTO customer_support_messages(ticket_id,sender_type,sender_id,message) VALUES(999999,'admin','admin','orphan')"),
      error => error && error.code === 'ER_NO_REFERENCED_ROW_2'
    );

    // Real concurrent payment/order/code tests use independent MySQL connections.
    const pool = mysql.createPool({
      host: process.env.MYSQL_TEST_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER,
      password: process.env.MYSQL_TEST_PASSWORD,
      database,
      connectionLimit: 12,
      waitForConnections: true
    });
    try {
      const { createCampaignService } = require('../src/campaign-service');
      const { createBankCardService } = require('../src/bank-card-service');
      const campaignService = createCampaignService({ db: pool, adminId: 'integration-test' });
      const bankCardService = createBankCardService({ db: pool, adminId: 'integration-test' });
      const [cardResult] = await pool.execute(
        "INSERT INTO bank_cards(label,bank_name,card_number,cardholder_name,created_by) VALUES('Integration card','Test Bank','6037990000000000','USTORE Test','integration-test')"
      );
      const cardId = cardResult.insertId;
      const [capacityCampaign] = await pool.execute(
        "INSERT INTO campaigns(slug,name,status,payment_mode,current_payment_card_id,price_per_code,currency,max_participants,max_codes,max_codes_per_participant,created_by) VALUES('race-capacity','Race capacity','open','manual',?,1000,'IRR',1,1,1,'integration-test')",
        [cardId]
      );
      const participantIds = [];
      for (let i=0;i<4;i++) {
        const [p] = await pool.execute(
          "INSERT INTO participants(telegram_user_id,chat_id,full_name,phone,instagram,status) VALUES(?,?,?,?,?,'active')",
          [920001+i,920001+i,'Integration User '+i,'0912000'+String(920001+i).slice(-4),'itest'+i]
        );
        participantIds.push(p.insertId);
      }

      const capacityRace = await Promise.allSettled([
        campaignService.reserveManualOrder({campaignId:capacityCampaign.insertId,participantId:participantIds[0],quantity:1}),
        campaignService.reserveManualOrder({campaignId:capacityCampaign.insertId,participantId:participantIds[1],quantity:1})
      ]);
      assert.equal(capacityRace.filter(x=>x.status==='fulfilled').length,1,'campaign row lock must prevent capacity oversubscription');
      assert.equal(capacityRace.filter(x=>x.status==='rejected').length,1,'the second concurrent reservation must be rejected');
      const [[capacityCounts]] = await pool.execute(
        "SELECT COUNT(*) AS orders,(SELECT COUNT(*) FROM campaign_capacity_reservations WHERE campaign_id=? AND status='held') AS held FROM payment_orders WHERE campaign_id=?",
        [capacityCampaign.insertId,capacityCampaign.insertId]
      );
      assert.equal(Number(capacityCounts.orders),1);
      assert.equal(Number(capacityCounts.held),1);

      const [paymentCampaign] = await pool.execute(
        "INSERT INTO campaigns(slug,name,status,payment_mode,current_payment_card_id,price_per_code,currency,max_participants,max_codes,max_codes_per_participant,created_by) VALUES('race-payment','Race payment','open','manual',?,1000,'IRR',10,10,3,'integration-test')",
        [cardId]
      );
      const sameOrderRace = await Promise.all([
        campaignService.reserveManualOrder({campaignId:paymentCampaign.insertId,participantId:participantIds[2],quantity:2}),
        campaignService.reserveManualOrder({campaignId:paymentCampaign.insertId,participantId:participantIds[2],quantity:2})
      ]);
      assert.equal(sameOrderRace[0].id,sameOrderRace[1].id,'simultaneous repeated order requests must resolve to one order');
      assert.equal(sameOrderRace.filter(x=>x.duplicate).length,1);
      const orderId = sameOrderRace[0].id;
      const [[orderCount]] = await pool.execute("SELECT COUNT(*) AS total FROM payment_orders WHERE id=?",[orderId]);
      assert.equal(Number(orderCount.total),1);

      const receiptRace = await Promise.all([
        campaignService.submitReceipt({orderId,fileId:'integration-file-a',fileUniqueId:'integration-file-unique'}),
        campaignService.submitReceipt({orderId,fileId:'integration-file-a',fileUniqueId:'integration-file-unique'})
      ]);
      assert.equal(receiptRace.filter(x=>x.duplicate).length,1,'duplicate Telegram receipt updates must be idempotent');
      const [[receiptCount]] = await pool.execute("SELECT COUNT(*) AS total FROM payment_receipts WHERE order_id=?",[orderId]);
      assert.equal(Number(receiptCount.total),1);

      const reviewRace = await Promise.allSettled([
        campaignService.reviewManualPayment({orderId,approve:true,trackingReference:'integration-transfer'}),
        campaignService.reviewManualPayment({orderId,approve:true,trackingReference:'integration-transfer'})
      ]);
      assert.equal(reviewRace.filter(x=>x.status==='fulfilled').length,1,'only one concurrent payment approval may win');
      assert.equal(reviewRace.filter(x=>x.status==='rejected').length,1,'the duplicate approval must observe the terminal order state');
      const [[paymentState]] = await pool.execute(
        "SELECT o.status,(SELECT COUNT(*) FROM payment_transactions t WHERE t.order_id=o.id AND t.status='confirmed') AS transactions,(SELECT COUNT(*) FROM campaign_codes c WHERE c.entry_id=o.entry_id AND c.status='active') AS codes FROM payment_orders o WHERE o.id=?",
        [orderId]
      );
      assert.equal(paymentState.status,'approved');
      assert.equal(Number(paymentState.transactions),1,'one confirmed transaction must be persisted');
      assert.equal(Number(paymentState.codes),2,'exactly quantity codes must be issued');

      // The outbox id is the durable identity used to record card delivery.
      const [[instruction]] = await pool.execute(
        "SELECT id FROM telegram_notification_outbox WHERE dedupe_key=?",
        ['payment-instructions:'+orderId]
      );
      assert.ok(instruction,'payment instructions must be committed to the outbox with the order');
      await bankCardService.recordDelivery({
        orderId,
        outboxId:instruction.id,
        card:{id:cardId,label:'Integration card',bank_name:'Test Bank',card_number:'6037990000000000',cardholder_name:'USTORE Test'}
      });
      await bankCardService.recordDelivery({
        orderId,
        outboxId:instruction.id,
        card:{id:cardId,label:'Integration card',bank_name:'Test Bank',card_number:'6037990000000000',cardholder_name:'USTORE Test'}
      });
      const [[deliveryCount]] = await pool.execute(
        "SELECT COUNT(*) AS total FROM payment_order_card_deliveries WHERE order_id=? AND outbox_id=?",
        [orderId,instruction.id]
      );
      assert.equal(Number(deliveryCount.total),1,'the same outbox delivery must not create duplicate card-history rows');
    } finally {
      await pool.end();
    }
  } finally {
    await verify.end();
    const cleanup = await mysql.createConnection({
      host: process.env.MYSQL_TEST_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER,
      password: process.env.MYSQL_TEST_PASSWORD
    });
    try { await cleanup.query('DROP DATABASE IF EXISTS `' + database + '`'); }
    finally { await cleanup.end(); }
  }
});
