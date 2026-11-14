'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

test('fresh database bootstrap creates only the normalized multi-campaign schema', { skip: !enabled }, async () => {
  const database = 'ustore_fresh_schema_test_' + process.pid + '_' + Date.now();
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
    for (const [table,column] of [
      ['webhook_inbox','correlation_id'],
      ['telegram_notification_outbox','correlation_id'],
      ['admin_audit_log','correlation_id'],
      ['payment_orders','correlation_id'],
      ['payment_order_card_deliveries','correlation_id'],
      ['telegram_notification_outbox','delivery_recorded_at'],
      ['telegram_notification_outbox','post_delivery_token']
    ]) {
      const [[found]] = await verify.execute(
        'SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
        [table,column]
      );
      assert.equal(Number(found.total),1,'missing operational migration column '+table+'.'+column);
    }
    const [[rateTable]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_rate_limits'"
    );
    assert.equal(Number(rateTable.total),1);
    const [[rateEventsTable]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='webhook_rate_limit_events'"
    );
    assert.equal(Number(rateEventsTable.total),1);

    // Rebuild the bank-card index/FK after a simulated partial migration.
    await verify.query('ALTER TABLE campaigns DROP FOREIGN KEY fk_campaign_payment_card');
    await verify.query('ALTER TABLE campaigns DROP INDEX idx_campaign_payment_card');
    await require('../migrations/bank-cards').up(verify);
    const [[cardForeignKey]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaigns' AND COLUMN_NAME='current_payment_card_id' AND REFERENCED_TABLE_NAME='bank_cards'"
    );
    assert.equal(Number(cardForeignKey.total),1,'bank-card migration must repair missing foreign key');
    const [[cardIndex]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaigns' AND COLUMN_NAME='current_payment_card_id'"
    );
    assert.ok(Number(cardIndex.total)>=1,'bank-card migration must repair missing index');

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
    await verify.query('ALTER TABLE customer_support_messages DROP INDEX idx_support_messages_ticket');
    await supportMigration.up(verify);
    const [[restoredSupportIndex]] = await verify.execute(
      "SELECT COUNT(DISTINCT INDEX_NAME) AS total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_messages' AND INDEX_NAME='idx_support_messages_ticket'"
    );
    assert.equal(Number(restoredSupportIndex.total),1,'support migration must repair a partially applied index');
    await verify.query('ALTER TABLE customer_support_messages DROP FOREIGN KEY fk_support_message_ticket');
    await supportMigration.up(verify);
    const [[restoredSupportForeignKey]] = await verify.execute(
      "SELECT COUNT(*) AS total FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_support_messages' AND COLUMN_NAME='ticket_id' AND REFERENCED_TABLE_NAME='customer_support_tickets'"
    );
    assert.equal(Number(restoredSupportForeignKey.total),1,'support migration must repair a missing ticket foreign key');

    // Simulate a partially applied customer-flow migration with duplicate Telegram IDs.
    await verify.query('ALTER TABLE customer_support_tickets DROP INDEX uq_support_telegram_message');
    await verify.execute(
      'INSERT INTO customer_support_tickets(telegram_user_id,chat_id,message,telegram_message_id) VALUES(?,?,?,?)',
      [910001,910001,'Duplicate legacy ticket row',910001]
    );
    const [migrationParticipant]=await verify.execute(
      "INSERT INTO participants(telegram_user_id,chat_id,full_name,phone,instagram,status) VALUES(?,?,?,?,?,'active')",
      [930100,930100,'Migration Participant','0912930100','migrationparticipant']
    );
    await verify.query('ALTER TABLE profile_change_requests ADD KEY idx_test_profile_participant(participant_id)');
    await verify.query('ALTER TABLE profile_change_requests DROP INDEX uq_profile_change_telegram_message');
    for(const value of ['first request','duplicate request']) {
      await verify.execute(
        "INSERT INTO profile_change_requests(participant_id,field_name,old_value,requested_value,telegram_message_id) VALUES(?,'full_name','Old Name',?,930100)",
        [migrationParticipant.insertId,value]
      );
    }
    const customerFlowMigration=require('../migrations/customer-flow');
    await customerFlowMigration.up(verify);
    const [[ticketDedupe]] = await verify.execute(
      'SELECT SUM(telegram_message_id IS NOT NULL) AS linked,SUM(telegram_message_id IS NULL) AS unlinked FROM customer_support_tickets WHERE telegram_user_id=910001'
    );
    assert.equal(Number(ticketDedupe.linked),1);
    assert.equal(Number(ticketDedupe.unlinked),1);
    const [[profileDedupe]] = await verify.execute(
      'SELECT SUM(telegram_message_id IS NOT NULL) AS linked,SUM(telegram_message_id IS NULL) AS unlinked FROM profile_change_requests WHERE participant_id=?',
      [migrationParticipant.insertId]
    );
    assert.equal(Number(profileDedupe.linked),1);
    assert.equal(Number(profileDedupe.unlinked),1);
    await supportMigration.up(verify);

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
      const { bindPool, runWithCorrelation } = require('../src/correlation-context');
      bindPool(pool);
      const correlationId='123e4567-e89b-42d3-a456-426614174099';
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
      const sameOrderRace = await runWithCorrelation(correlationId,()=>Promise.all([
        campaignService.reserveManualOrder({campaignId:paymentCampaign.insertId,participantId:participantIds[2],quantity:2}),
        campaignService.reserveManualOrder({campaignId:paymentCampaign.insertId,participantId:participantIds[2],quantity:2})
      ]));
      assert.equal(sameOrderRace[0].id,sameOrderRace[1].id,'simultaneous repeated order requests must resolve to one order');
      assert.equal(sameOrderRace.filter(x=>x.duplicate).length,1);
      const orderId = sameOrderRace[0].id;
      const [[orderCount]] = await pool.execute("SELECT COUNT(*) AS total,MAX(correlation_id) AS correlation_id FROM payment_orders WHERE id=?",[orderId]);
      assert.equal(Number(orderCount.total),1);
      assert.equal(orderCount.correlation_id,correlationId,'payment order must retain the originating webhook correlation ID');

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
        "SELECT id,correlation_id FROM telegram_notification_outbox WHERE dedupe_key=?",
        ['payment-instructions:'+orderId]
      );
      assert.ok(instruction,'payment instructions must be committed to the outbox with the order');
      assert.equal(instruction.correlation_id,correlationId,'outbox notification must inherit the webhook correlation ID');
      await pool.execute("UPDATE telegram_notification_outbox SET status='sent',sent_at=UTC_TIMESTAMP(),delivery_recorded_at=UTC_TIMESTAMP() WHERE status='pending' AND id<>?",[instruction.id]);
      await pool.execute("UPDATE telegram_notification_outbox SET delivery_recorded_at=UTC_TIMESTAMP() WHERE notification_type='payment_instructions' AND id<>?",[instruction.id]);
      const {createNotificationOutbox}=require('../src/notification-outbox');
      let telegramSends=0,deliveryHooks=0;
      const outboxErrors=[];
      const notificationWorker=createNotificationOutbox({
        db:pool,leaseMs:5000,heartbeatMs:1000,
        send:async()=>{telegramSends++;},
        onSent:async item=>{
          deliveryHooks++;
          if(deliveryHooks===1)throw new Error('simulated card-history write failure');
          await bankCardService.recordDelivery({...item.payload.delivery_card,outboxId:item.id});
        },
        logger:{error(...args){outboxErrors.push(args.join(' '));}}
      });
      assert.equal(await notificationWorker.processOne(),false,'post-send history failure must remain recoverable');
      const [[sentButUnaudited]]=await pool.execute("SELECT status,delivery_recorded_at FROM telegram_notification_outbox WHERE id=?",[instruction.id]);
      assert.equal(sentButUnaudited.status,'sent','Telegram success must not be downgraded to pending when card audit fails; worker errors: '+outboxErrors.join(' | '));
      assert.equal(sentButUnaudited.delivery_recorded_at,null);
      assert.equal(await notificationWorker.processOne(),true,'worker must retry the card audit independently');
      assert.equal(telegramSends,1,'recovery must not resend the payment instructions');
      assert.equal(deliveryHooks,2);
      const [[deliveryMarker]]=await pool.execute("SELECT delivery_recorded_at FROM telegram_notification_outbox WHERE id=?",[instruction.id]);
      assert.ok(deliveryMarker.delivery_recorded_at,'successful card history must be durably marked on the outbox');
      await runWithCorrelation(correlationId,()=>bankCardService.recordDelivery({
        orderId,
        outboxId:instruction.id,
        card:{id:cardId,label:'Integration card',bank_name:'Test Bank',card_number:'6037990000000000',cardholder_name:'USTORE Test'}
      }));
      const [[deliveryCount]] = await pool.execute(
        "SELECT COUNT(*) AS total,MAX(correlation_id) AS correlation_id FROM payment_order_card_deliveries WHERE order_id=? AND outbox_id=?",
        [orderId,instruction.id]
      );
      assert.equal(Number(deliveryCount.total),1,'the same outbox delivery must not create duplicate card-history rows');
      assert.equal(deliveryCount.correlation_id,correlationId,'card delivery history must retain the same correlation ID');

      // Simulate a partially applied delivery migration and pre-existing duplicate links.
      await pool.query('ALTER TABLE payment_order_card_deliveries DROP INDEX uq_card_delivery_outbox');
      await pool.execute(
        "INSERT INTO payment_order_card_deliveries(order_id,outbox_id,card_id,card_label_snapshot,bank_name_snapshot,card_number_snapshot,cardholder_name_snapshot) VALUES(?,?,?,?,?,?,?)",
        [orderId,instruction.id,cardId,'Duplicate legacy link','Test Bank','6037990000000000','USTORE Test']
      );
      const operationalMigration=require('../migrations/operational-observability');
      await operationalMigration.up(pool);
      await operationalMigration.up(pool);
      const [[deduplicated]] = await pool.execute(
        "SELECT SUM(outbox_id IS NOT NULL) AS linked,SUM(outbox_id IS NULL) AS unlinked FROM payment_order_card_deliveries WHERE order_id=?",
        [orderId]
      );
      assert.equal(Number(deduplicated.linked),1,'migration must retain exactly one canonical outbox link');
      assert.equal(Number(deduplicated.unlinked),1,'migration must preserve the legacy delivery row while removing duplicate linkage');

      const {consumeTelegramRateLimit}=require('../src/telegram-rate-limit');
      const first=await consumeTelegramRateLimit(pool,{userId:'930001',bucket:'integration',limit:2,windowMs:60000});
      const second=await consumeTelegramRateLimit(pool,{userId:'930001',bucket:'integration',limit:2,windowMs:60000});
      const third=await consumeTelegramRateLimit(pool,{userId:'930001',bucket:'integration',limit:2,windowMs:60000});
      assert.equal(first.allowed,true);
      assert.equal(second.allowed,true);
      assert.equal(third.allowed,false,'persistent MySQL rate limit must reject request above quota');
      const concurrentLimits=await Promise.all(Array.from({length:8},()=>consumeTelegramRateLimit(pool,{userId:'930002',bucket:'parallel',limit:3,windowMs:60000})));
      assert.equal(concurrentLimits.filter(x=>x.allowed).length,3,'concurrent requests must not exceed the MySQL quota');
      assert.equal(concurrentLimits.filter(x=>x.limited).length,5);

      // Recover an abandoned processing lease and finish it exactly once.
      const webhookCorrelation='123e4567-e89b-42d3-a456-426614174098';
      await pool.execute(
        "INSERT INTO webhook_inbox(update_id,payload,status,attempts,processing_started_at,processing_token,correlation_id) VALUES(?,?,'processing',0,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 600 SECOND),?,?)",
        [940001,JSON.stringify({update_id:940001,business_message:{from:{id:940002},text:'recovered'}}),'123e4567-e89b-42d3-a456-426614174097',webhookCorrelation]
      );
      const {createWebhookQueue}=require('../src/webhook-queue');
      const {getCorrelationId}=require('../src/correlation-context');
      let recovered=0,observedCorrelation=null;
      const webhookQueue=createWebhookQueue({
        db:pool,leaseMs:1000,heartbeatMs:1000,
        handlers:{business:async()=>{recovered++;observedCorrelation=getCorrelationId();}},
        logger:{error(...args){throw new Error(args.join(' '));}}
      });
      assert.equal(await webhookQueue.processOne(),false,'stale lease is deferred for retry backoff');
      await new Promise(resolve=>setTimeout(resolve,1100));
      assert.equal(await webhookQueue.processOne(),true,'stale webhook must be reclaimed and processed');
      assert.equal(recovered,1);
      assert.equal(observedCorrelation,webhookCorrelation);
      const [[webhookState]]=await pool.execute("SELECT status,correlation_id FROM webhook_inbox WHERE update_id=940001");
      assert.equal(webhookState.status,'done');
      assert.equal(webhookState.correlation_id,webhookCorrelation);
      const [[processedUpdate]]=await pool.execute("SELECT COUNT(*) AS total FROM processed_updates WHERE update_id=940001");
      assert.equal(Number(processedUpdate.total),1);
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
