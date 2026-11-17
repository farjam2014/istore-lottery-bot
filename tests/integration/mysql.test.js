import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';
test('MySQL integration: clean schema, unique profile, multiple campaigns, frozen snapshot and idempotent codes',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Integration tests only run against a database ending in _ci or _test');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createProfile,findByTelegramId}=await import('../../src/modules/participants/participant.repository.js');
  const {joinFreeCampaign}=await import('../../src/modules/entries/entry.service.js');
  let participantId;const campaignIds=[];let telegramId;
  try{
    // Simulate a process crash after the first DDL statement of migration 001:
    // the index exists, but schema_migrations has not recorded the migration yet.
    const {readFile}=await import('node:fs/promises');
    const {fileURLToPath}=await import('node:url');
    const {dirname,resolve}=await import('node:path');
    const schemaPath=resolve(dirname(fileURLToPath(import.meta.url)),'../../src/database/schema.sql');
    const baseSql=await readFile(schemaPath,'utf8');
    for(const statement of baseSql.split(/;\\s*(?:\\n|$)/).map(x=>x.trim()).filter(Boolean)) await pool.query(statement);
    const [[recoveryIndex]]=await pool.execute(
      "SELECT COUNT(*) total FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaign_entries' AND INDEX_NAME='uq_entry_id_campaign'"
    );
    if(Number(recoveryIndex.total)===0) await pool.query('ALTER TABLE campaign_entries ADD UNIQUE KEY uq_entry_id_campaign(id,campaign_id)');
    await migrate();
    const [[recoveredMigration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261117_001_campaign_code_sequence.sql'");
    assert.match(recoveredMigration.checksum,/^[a-f0-9]{64}$/);
    telegramId=String(700000000000n+(BigInt(Date.now())%100000000000n));
    await createProfile({telegramUserId:telegramId,username:'integration',fullName:'Integration Tester',phone:'+989121234567',instagramHandle:'integration_test'});
    const profile=await findByTelegramId(telegramId);participantId=profile.id;
    assert.equal(String(profile.telegram_user_id),telegramId);
    await assert.rejects(
      pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Duplicate Tester','+989121234567','duplicate_user']),
      e=>e.code==='ER_DUP_ENTRY'
    );
    for(let i=0;i<2;i++){
      const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'open','free',2)",[`it-${telegramId}-${i}`,`Integration campaign ${i}`]);
      campaignIds.push(c.insertId);
    }
    const first=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[0]});
    assert.equal(first.codes.length,2);assert.equal(first.alreadyJoined,false);
    const repeated=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[0]});
    assert.equal(repeated.alreadyJoined,true);assert.deepEqual(repeated.codes,first.codes);
    const second=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[1]});
    assert.equal(second.codes.length,2);assert.notDeepEqual(second.codes,first.codes);
    for(const campaignId of campaignIds){
      const [issued]=await pool.execute('SELECT sequence_number,random_prefix,random_suffix,format_version,status,code FROM campaign_codes WHERE campaign_id=? ORDER BY sequence_number',[campaignId]);
      assert.deepEqual(issued.map(x=>Number(x.sequence_number)),[10001,10002]);
      assert.ok(issued.every(x=>Number(x.format_version)===2&&x.status==='active'&&x.code.length>0));
      assert.ok(issued.every(x=>String(x.random_prefix).length===1&&/^[ABCDEFGHJKLMNPQRSTUVWXYZ0]$/.test(x.random_prefix)));
      assert.ok(issued.every(x=>/^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789][ABCDEFGHJKLMNPQRSTUVWXYZ0]$/.test(x.random_suffix)));
    }
    await pool.execute("UPDATE participants SET full_name='Changed Name' WHERE id=?",[participantId]);
    const [[entry]]=await pool.execute('SELECT profile_snapshot FROM campaign_entries WHERE campaign_id=? AND participant_id=?',[campaignIds[0],participantId]);
    const snapshot=typeof entry.profile_snapshot==='string'?JSON.parse(entry.profile_snapshot):entry.profile_snapshot;
    assert.equal(snapshot.full_name,'Integration Tester');
    const [[count]]=await pool.execute('SELECT COUNT(*) AS total FROM campaign_codes WHERE campaign_id=?',[campaignIds[0]]);
    assert.equal(Number(count.total),2);
  }finally{
    if(participantId){
      const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[participantId]);
      for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);
      await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[participantId]);
      await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
    }
    if(campaignIds.length)await pool.execute(`DELETE FROM campaigns WHERE id IN (${campaignIds.map(()=>'?').join(',')})`,campaignIds);
  }
});


test('MySQL integration: paid order receipt review is idempotent and codes issue only after approval',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createOrGetOrder,submitReceipt,reviewReceipt,updatePaymentSettings,expirePendingOrders}=await import('../../src/modules/payments/payment.service.js');
  let participantId;let campaignId;let orderId;let previousOrderId;let receiptId;let telegramId;const financeAdminId=String(890000000000n+(BigInt(Date.now())%100000000000n));
  try{
    await migrate();
    telegramId=String(800000000000n+(BigInt(Date.now())%100000000000n));
    const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[telegramId,'Paid Integration','+989121111111','paid_test']);participantId=p.insertId;
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'open','paid',150000,2)",['paid-it-'+telegramId,'Paid integration']);campaignId=c.insertId;
    await updatePaymentSettings({bankName:'Test Bank',cardNumber:'1234567812345678',cardHolder:'Test Holder',instructions:'',adminId:'1'});
    const created=await createOrGetOrder({telegramUserId:telegramId,campaignId});orderId=created.order.id;
    assert.equal(Number(created.order.amount),150000);
    const before=await pool.execute('SELECT COUNT(*) total FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id WHERE e.campaign_id=?',[campaignId]);
    assert.equal(Number(before[0][0].total),0);
    const repeated=await createOrGetOrder({telegramUserId:telegramId,campaignId});assert.equal(repeated.order.id,orderId);assert.equal(repeated.order.card_number,'1234567812345678');await updatePaymentSettings({bankName:'Changed Bank',cardNumber:'8765432187654321',cardHolder:'Changed Holder',instructions:'changed',adminId:'1'});const [[cardSnapshot]]=await pool.execute('SELECT card_number FROM payment_orders WHERE id=?',[orderId]);assert.equal(cardSnapshot.card_number,'1234567812345678');previousOrderId=orderId;await pool.execute('UPDATE payment_orders SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE id=?',[orderId]);assert.equal(await expirePendingOrders(),1);const [[expiredOrder]]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[previousOrderId]);assert.equal(expiredOrder.status,'expired');const renewed=await createOrGetOrder({telegramUserId:telegramId,campaignId});orderId=renewed.order.id;assert.notEqual(orderId,previousOrderId);assert.equal(renewed.order.status,'awaiting_receipt');assert.match(renewed.order.payment_reference,/^ISTPAY-/);assert.equal(renewed.order.card_number,'8765432187654321');
    receiptId=(await submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-1',fileUniqueId:'unique-test-'+telegramId,note:'test',adminIds:[financeAdminId]})).receiptId;const [[adminNotice]]=await pool.execute("SELECT payload FROM telegram_notification_outbox WHERE chat_id=? ORDER BY id DESC LIMIT 1",[financeAdminId]);const adminPayload=typeof adminNotice.payload==='string'?JSON.parse(adminNotice.payload):adminNotice.payload;assert.match(adminPayload.text,/رسید جدید برای سفارش/);assert.match(adminPayload.text,new RegExp(String(orderId)));assert.equal(adminPayload.photo,'file-test-1');assert.match(adminPayload.caption,/شناسه پرداخت:/);assert.match(adminPayload.caption,/کمپین:/);assert.match(adminPayload.caption,/موبایل:/);assert.match(adminPayload.caption,/اینستاگرام:/);assert.equal(adminPayload.options.reply_markup.inline_keyboard[0][0].callback_data,'payment:approve:'+receiptId);
    await assert.rejects(submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-2',fileUniqueId:'unique-test-'+telegramId}),/قبلاً/);
    await reviewReceipt({adminId:'1',receiptId,decision:'reject',reason:'رسید آزمایشی نامعتبر'});
    const [[rejectionNotice]]=await pool.execute("SELECT payload FROM telegram_notification_outbox WHERE chat_id=? ORDER BY id DESC LIMIT 1",[telegramId]);
    const rejectionPayload=typeof rejectionNotice.payload==='string'?JSON.parse(rejectionNotice.payload):rejectionNotice.payload;
    assert.match(rejectionPayload.text,/رسید پرداخت سفارش/);assert.match(rejectionPayload.text,/رسید آزمایشی نامعتبر/);
    await assert.rejects(reviewReceipt({adminId:'1',receiptId,decision:'approve'}),/قبلاً/);
    const [afterReject]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[orderId]);assert.equal(afterReject[0].status,'rejected');
    const retry=await submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-2',fileUniqueId:'unique-test-2-'+telegramId});
    await reviewReceipt({adminId:'1',receiptId:retry.receiptId,decision:'approve'});
    const [[approvalNotice]]=await pool.execute("SELECT payload FROM telegram_notification_outbox WHERE chat_id=? ORDER BY id DESC LIMIT 1",[telegramId]);
    const approvalPayload=typeof approvalNotice.payload==='string'?JSON.parse(approvalNotice.payload):approvalNotice.payload;
    assert.match(approvalPayload.text,/پرداخت سفارش/);assert.match(approvalPayload.text,/کدهای شرکت شما/);
    const [codes]=await pool.execute('SELECT cc.code,cc.sequence_number,cc.random_prefix,cc.random_suffix,cc.format_version FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id WHERE e.campaign_id=? ORDER BY cc.sequence_number',[campaignId]);
    assert.equal(codes.length,2);
    assert.deepEqual(codes.map(x=>Number(x.sequence_number)),[10001,10002]);
    assert.ok(codes.every(x=>Number(x.format_version)===2));
    await assert.rejects(reviewReceipt({adminId:'1',receiptId:retry.receiptId,decision:'approve'}),/قبلاً/);
    const [[order]]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[orderId]);assert.equal(order.status,'approved');
  }finally{
    if(telegramId)await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[telegramId]);await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[financeAdminId]);
    for(const id of [orderId,previousOrderId].filter(Boolean)){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[id]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[id]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[id]);}
    if(participantId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[participantId]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[participantId]);await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);}
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
  }
});


test('MySQL integration: versioned campaign migration adds full public campaign metadata',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [columns]=await pool.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='campaigns'");
    const names=new Set(columns.map(x=>x.COLUMN_NAME));
    for(const name of ['poster_file_id','prize_title','prize_description','prize_value','draw_at','terms','payment_methods'])assert.ok(names.has(name),`Missing campaign column: ${name}`);
    const [[migration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_002_campaign_details.sql'");
    assert.match(migration.checksum,/^[a-f0-9]{64}$/);
  }finally{}
});


test('MySQL integration: support ticket tables and workflow constraints exist',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [tables]=await pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('support_tickets','support_messages','support_sessions')");
    assert.deepEqual(new Set(tables.map(x=>x.TABLE_NAME)),new Set(['support_tickets','support_messages','support_sessions']));
    const [[migration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_003_support_tickets.sql'");
    assert.match(migration.checksum,/^[a-f0-9]{64}$/);
    const [columns]=await pool.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_tickets'");
    const names=new Set(columns.map(x=>x.COLUMN_NAME));
    for(const name of ['ticket_number','participant_id','category','subject','status','priority','assigned_admin_id','last_message_at'])assert.ok(names.has(name),`Missing support ticket column: ${name}`);
  }finally{}
});


test('MySQL integration: admin role tables and audit history schema exist',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [tables]=await pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('admin_users','admin_role_events','admin_role_sessions')");
    assert.deepEqual(new Set(tables.map(x=>x.TABLE_NAME)),new Set(['admin_users','admin_role_events','admin_role_sessions']));
    const [[migration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_004_admin_roles.sql'");
    assert.match(migration.checksum,/^[a-f0-9]{64}$/);
  }finally{}
});


test('MySQL integration: admin roles can be assigned changed and deactivated with audit events',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const id=String(800000000000n+(BigInt(Date.now())%100000000000n));
  try{
    await migrate();
    await pool.execute("INSERT INTO admin_users(telegram_user_id,role,is_active) VALUES(?,'support_agent',1)",[id]);
    const [[before]]=await pool.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=?',[id]);
    assert.equal(before.role,'support_agent');assert.equal(Number(before.is_active),1);
    await pool.execute("UPDATE admin_users SET role='finance_manager' WHERE telegram_user_id=?",[id]);
    await pool.execute("UPDATE admin_users SET is_active=0 WHERE telegram_user_id=?",[id]);
    const [[after]]=await pool.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=?',[id]);
    assert.equal(after.role,'finance_manager');assert.equal(Number(after.is_active),0);
  }finally{
    await pool.execute('DELETE FROM admin_users WHERE telegram_user_id=?',[id]);
  }
});


test('MySQL integration: management report aggregates return complete dashboard metrics',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {getManagementReport}=await import('../../src/modules/reports/management-report.service.js');
  try{
    await migrate();
    const report=await getManagementReport();
    for(const key of ['users','campaigns','entries','payments','receipts','topCampaigns','recent','newUsers'])assert.ok(Object.hasOwn(report,key),'Missing report section: '+key);
    assert.ok(Array.isArray(report.topCampaigns));
    for(const key of ['total','active','blocked'])assert.ok(Object.hasOwn(report.users,key));
    for(const key of ['total','approved_count','rejected_count','revenue','pending_amount'])assert.ok(Object.hasOwn(report.payments,key));
  }finally{}
});


test('MySQL integration: payment operations search filters detail and export are consistent',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {listManagedOrders,searchManagedOrders,getManagedOrderDetail,exportManagedOrders}=await import('../../src/modules/payments/payment-admin.service.js');
  let participantId,campaignId,entryId,orderId;
  const uid=String(850000000000n+(BigInt(Date.now())%100000000000n));
  const reference='ITPAY-'+uid;
  try{
    await migrate();
    const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[uid,'Payment Admin Test','+989123456789','payment_admin_test']);
    participantId=p.insertId;
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'open','paid',100000,1)",['pay-admin-'+uid,'Payment Admin Campaign']);
    campaignId=c.insertId;
    const [e]=await pool.execute("INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('full_name','Payment Admin Test'),'pending_payment')",[campaignId,participantId]);
    entryId=e.insertId;
    const [o]=await pool.execute("INSERT INTO payment_orders(campaign_entry_id,payment_reference,amount,currency,status,expires_at) VALUES(?, ?,100000,'IRR','awaiting_receipt',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY))",[entryId,reference]);
    orderId=o.insertId;
    const list=await listManagedOrders({status:'awaiting_receipt',page:0,limit:10});
    assert.ok(list.rows.some(x=>Number(x.id)===Number(orderId)));
    const found=await searchManagedOrders(reference);
    assert.ok(found.some(x=>Number(x.id)===Number(orderId)));
    const detail=await getManagedOrderDetail(orderId);
    assert.equal(detail.order.payment_reference,reference);assert.equal(detail.receipts.length,0);
    const exported=await exportManagedOrders({status:'awaiting_receipt'});
    assert.ok(exported.some(x=>Number(x.id)===Number(orderId)));
  }finally{
    if(orderId){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[orderId]);}
    if(entryId){await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[entryId]);await pool.execute('DELETE FROM campaign_entries WHERE id=?',[entryId]);}
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
  }
});

test('MySQL integration: payment admin search session migration exists',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  try{await migrate();const [tables]=await pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_admin_sessions'");assert.equal(tables.length,1);const [[m]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_005_payment_admin_sessions.sql'");assert.match(m.checksum,/^[a-f0-9]{64}$/);}finally{}
});


test('MySQL integration: campaign code search session migration supports campaign-scoped search',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  await migrate();
  const [columns]=await pool.execute("SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_search_sessions'");
  const step=columns.find(x=>x.COLUMN_NAME==='step');assert.ok(step);assert.match(step.COLUMN_TYPE,/campaign_code/);
  assert.ok(columns.some(x=>x.COLUMN_NAME==='campaign_id'));
});

test('MySQL integration: concurrent free entries receive unique sequential campaign codes',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');const {joinFreeCampaign}=await import('../../src/modules/entries/entry.service.js');
  const ids=[1,2,3,4].map(n=>String(BigInt(760000000000+n*10000000000)+(BigInt(Date.now())%1000000000n)));const participantIds=[];let campaignId;
  try{
    await migrate();
    for(let i=0;i<ids.length;i++){const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[ids[i],'Sequence Race '+i,'+98912144444'+i,'sequence_race_'+i]);participantIds.push(p.insertId);}
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'open','free',2)",['sequence-race-'+ids[0],'Sequence race']);campaignId=c.insertId;
    const outcomes=await Promise.all(ids.map(telegramUserId=>joinFreeCampaign({telegramUserId,campaignId})));
    assert.ok(outcomes.every(x=>x.codes.length===2));
    const [rows]=await pool.execute('SELECT sequence_number,code FROM campaign_codes WHERE campaign_id=? ORDER BY sequence_number',[campaignId]);
    assert.deepEqual(rows.map(x=>Number(x.sequence_number)),[10001,10002,10003,10004,10005,10006,10007,10008]);
    assert.equal(new Set(rows.map(x=>x.code)).size,8);
    const [[counter]]=await pool.execute('SELECT last_sequence FROM campaign_code_counters WHERE campaign_id=?',[campaignId]);assert.equal(Number(counter.last_sequence),10008);
  }finally{
    if(campaignId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE campaign_id=?',[campaignId]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}
    for(const id of participantIds)await pool.execute('DELETE FROM participants WHERE id=?',[id]);
  }
});
test('MySQL integration: failure after the first code insert rolls back all codes and the counter',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {issueCampaignCodes}=await import('../../src/modules/codes/code-issuance.service.js');
  const suffix=String(Date.now());let campaignId,participantId,entryId;
  try{
    await migrate();
    const [participant]=await pool.execute(
      "INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",
      [String(990000000000n+(BigInt(Date.now())%10000000000n)),'Rollback Integration','+989121555555','rollback_integration']
    );
    participantId=participant.insertId;
    const [campaign]=await pool.execute(
      "INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'open','free',3)",
      ['code-rollback-'+suffix,'Code rollback']
    );
    campaignId=campaign.insertId;
    const [entry]=await pool.execute(
      "INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,JSON_OBJECT('full_name','Rollback Integration'),'eligible')",
      [campaignId,participantId]
    );
    entryId=entry.insertId;
    await pool.execute('INSERT INTO campaign_code_counters(campaign_id,last_sequence) VALUES(?,10000)',[campaignId]);
    const connection=await pool.getConnection();
    let codeInsertAttempts=0;
    const failingConnection={
      execute:async(sql,params)=>{
        if(/^\\s*INSERT INTO campaign_codes/i.test(sql) && ++codeInsertAttempts===2){
          throw new Error('injected second-code insert failure');
        }
        return connection.execute(sql,params);
      }
    };
    try{
      await connection.beginTransaction();
      await assert.rejects(issueCampaignCodes(failingConnection,entryId,campaignId,3),/injected second-code insert failure/);
      assert.equal(codeInsertAttempts,2,'The failure must occur after one successful code insert.');
      await connection.rollback();
    }finally{connection.release();}
    const [[counter]]=await pool.execute('SELECT last_sequence FROM campaign_code_counters WHERE campaign_id=?',[campaignId]);
    const [[codes]]=await pool.execute('SELECT COUNT(*) total FROM campaign_codes WHERE campaign_id=?',[campaignId]);
    assert.equal(Number(counter.last_sequence),10000);
    assert.equal(Number(codes.total),0);
  }finally{
    if(entryId)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[entryId]);
    if(entryId)await pool.execute('DELETE FROM campaign_entries WHERE id=?',[entryId]);
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
  }
});

test('MySQL integration: update guard and profile change workflow schema are available',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [tables]=await pool.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('admin_search_sessions','telegram_rate_limits','processed_updates','profile_change_sessions','profile_change_requests')");
    const names=new Set(tables.map(x=>x.TABLE_NAME));
    for(const name of ['admin_search_sessions','telegram_rate_limits','processed_updates','profile_change_sessions','profile_change_requests'])assert.ok(names.has(name),'Missing workflow table: '+name);
    const [[migration]]=await pool.execute("SELECT checksum FROM schema_migrations WHERE version='20261114_007_profile_change_sessions.sql'");
    assert.match(migration.checksum,/^[a-f0-9]{64}$/);
  }finally{}
});


test('MySQL integration: concurrent free registrations cannot exceed campaign capacity',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');const {joinFreeCampaign}=await import('../../src/modules/entries/entry.service.js');
  const ids=[String(710000000000n+(BigInt(Date.now())%100000000000n)),String(720000000000n+(BigInt(Date.now())%100000000000n))];const participantIds=[];let campaignId;
  try{await migrate();for(let i=0;i<2;i++){const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[ids[i],'Capacity Race '+i,'+98912111111'+i,'capacity_race_'+i]);participantIds.push(p.insertId);}
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,capacity,codes_per_entry) VALUES(?,?,'open','free',1,1)",['capacity-race-'+ids[0],'Capacity race']);campaignId=c.insertId;
    const outcomes=await Promise.allSettled(ids.map(telegramUserId=>joinFreeCampaign({telegramUserId,campaignId})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    const [[count]]=await pool.execute("SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",[campaignId]);assert.equal(Number(count.total),1);
    const [[codes]]=await pool.execute("SELECT COUNT(*) total FROM campaign_codes WHERE campaign_id=?",[campaignId]);assert.equal(Number(codes.total),1);
  }finally{if(campaignId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE campaign_id=?',[campaignId]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}for(const id of participantIds)await pool.execute('DELETE FROM participants WHERE id=?',[id]);}
});

test('MySQL integration: concurrent paid orders serialize capacity and remain idempotent',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');const {createOrGetOrder,updatePaymentSettings}=await import('../../src/modules/payments/payment.service.js');
  const ids=[String(730000000000n+(BigInt(Date.now())%100000000000n)),String(740000000000n+(BigInt(Date.now())%100000000000n))];const participantIds=[];let campaignId;
  try{await migrate();for(let i=0;i<2;i++){const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[ids[i],'Paid Capacity '+i,'+98912122222'+i,'paid_capacity_'+i]);participantIds.push(p.insertId);}
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,capacity,codes_per_entry) VALUES(?,?,'open','paid',100000,1,1)",['paid-capacity-'+ids[0],'Paid capacity race']);campaignId=c.insertId;
    await updatePaymentSettings({bankName:'CI Bank',cardNumber:'1234567812345678',cardHolder:'CI Holder',instructions:'',adminId:'1'});
    const outcomes=await Promise.allSettled(ids.map(telegramUserId=>createOrGetOrder({telegramUserId,campaignId})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    const [[entries]]=await pool.execute("SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",[campaignId]);assert.equal(Number(entries.total),1);
    const [[orders]]=await pool.execute("SELECT COUNT(*) total FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id WHERE e.campaign_id=? AND o.status IN ('awaiting_receipt','under_review','approved','rejected')",[campaignId]);assert.equal(Number(orders.total),1);
    const winnerIndex=outcomes.findIndex(x=>x.status==='fulfilled');const repeated=await createOrGetOrder({telegramUserId:ids[winnerIndex],campaignId});assert.equal(repeated.order.id,outcomes[winnerIndex].value.order.id);
    const [[entryCount]]=await pool.execute('SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=?',[campaignId]);assert.equal(Number(entryCount.total),1);
  }finally{if(campaignId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE campaign_id=?',[campaignId]);for(const e of entries){const [orders]=await pool.execute('SELECT id FROM payment_orders WHERE campaign_entry_id=?',[e.id]);for(const o of orders){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[o.id]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[o.id]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[o.id]);}await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);}await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}for(const id of participantIds)await pool.execute('DELETE FROM participants WHERE id=?',[id]);}
});

test('MySQL integration: concurrent receipt approvals issue codes and financial effects exactly once',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');const {createOrGetOrder,submitReceipt,reviewReceipt,updatePaymentSettings}=await import('../../src/modules/payments/payment.service.js');
  const uid=String(750000000000n+(BigInt(Date.now())%100000000000n));let participantId,campaignId,orderId,receiptId;
  try{await migrate();const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[uid,'Concurrent Review','+989121333333','concurrent_review']);participantId=p.insertId;
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'open','paid',100000,3)",['review-race-'+uid,'Review race']);campaignId=c.insertId;
    await updatePaymentSettings({bankName:'CI Bank',cardNumber:'1234567812345678',cardHolder:'CI Holder',instructions:'',adminId:'1'});
    const order=await createOrGetOrder({telegramUserId:uid,campaignId});orderId=order.order.id;receiptId=(await submitReceipt({telegramUserId:uid,orderId,fileId:'review-race-file-'+uid,fileUniqueId:'review-race-unique-'+uid})).receiptId;
    const outcomes=await Promise.allSettled([reviewReceipt({adminId:'9001',receiptId,decision:'approve'}),reviewReceipt({adminId:'9002',receiptId,decision:'approve'})]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
    const [[orderState]]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[orderId]);assert.equal(orderState.status,'approved');
    const [[entryState]]=await pool.execute('SELECT status FROM campaign_entries WHERE id=(SELECT campaign_entry_id FROM payment_orders WHERE id=?)',[orderId]);assert.equal(entryState.status,'eligible');
    const [[codeCount]]=await pool.execute('SELECT COUNT(*) total FROM campaign_codes WHERE campaign_entry_id=(SELECT campaign_entry_id FROM payment_orders WHERE id=?)',[orderId]);assert.equal(Number(codeCount.total),3);
    const [[eventCount]]=await pool.execute("SELECT COUNT(*) total FROM payment_events WHERE order_id=? AND event_type='payment_approved'",[orderId]);assert.equal(Number(eventCount.total),1);
    const [[noticeCount]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE chat_id=? AND payload LIKE '%پرداخت سفارش%'",[uid]);assert.equal(Number(noticeCount.total),1);
  }finally{if(uid)await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[uid]);if(orderId){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_orders WHERE id=?',[orderId]);}if(participantId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[participantId]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[participantId]);await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);}if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}
});


test('MySQL integration: last active database super admin cannot be deactivated or demoted',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {toggleAdminActive,changeAdminRole}=await import('../../src/modules/admin/admin-access.service.js');
  const suffix=String(Date.now()).slice(-10);const ids=[String(760000000000n+BigInt(suffix)),String(770000000000n+BigInt(suffix))];
  try{
    await migrate();
    await pool.execute("INSERT INTO admin_users(telegram_user_id,role,is_active) VALUES(?,'super_admin',1),(?,'super_admin',1)",ids);
    await toggleAdminActive({targetId:ids[0],actorId:'9000'});
    const [[remaining]]=await pool.execute("SELECT COUNT(*) total FROM admin_users WHERE role='super_admin' AND is_active=1 AND telegram_user_id IN (?,?)",ids);
    assert.equal(Number(remaining.total),1);
    await assert.rejects(toggleAdminActive({targetId:ids[1],actorId:'9000'}),/آخرین مدیر کل فعال/);
    await assert.rejects(changeAdminRole({targetId:ids[1],actorId:'9000',role:'finance_manager'}),/آخرین مدیر کل فعال/);
    const [[last]]=await pool.execute('SELECT role,is_active FROM admin_users WHERE telegram_user_id=?',[ids[1]]);
    assert.equal(last.role,'super_admin');assert.equal(Number(last.is_active),1);
  }finally{await pool.execute('DELETE FROM admin_role_events WHERE target_telegram_id IN (?,?)',ids);await pool.execute('DELETE FROM admin_users WHERE telegram_user_id IN (?,?)',ids);}
});


test('MySQL integration: transactional outbox notifications roll back and commit with business changes',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {enqueueTelegramNotification}=await import('../../src/modules/notifications/outbox.service.js');
  const chatId=String(780000000000n+(BigInt(Date.now())%100000000000n));
  try{
    await migrate();
    const rollback=await pool.getConnection();try{await rollback.beginTransaction();await enqueueTelegramNotification({chatId,text:'must rollback',executor:rollback});await rollback.rollback();}finally{rollback.release();}
    const [[afterRollback]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE chat_id=?",[chatId]);assert.equal(Number(afterRollback.total),0);
    const commit=await pool.getConnection();try{await commit.beginTransaction();await enqueueTelegramNotification({chatId,text:'must commit',executor:commit});await commit.commit();}finally{commit.release();}
    const [[afterCommit]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE chat_id=?",[chatId]);assert.equal(Number(afterCommit.total),1);
  }finally{await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[chatId]);}
});

test.after(async()=>{if(enabled){const {pool}=await import('../../src/database/pool.js');await pool.end();}});


test('MySQL integration: campaign scheduler transitions use database UTC time consistently',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {processCampaignSchedule}=await import('../../src/modules/campaigns/campaign-scheduler.js');
  const suffix=String(Date.now());const ids=[];
  try{
    await migrate();
    const [a]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,starts_at,ends_at) VALUES(?,?,'scheduled','free',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE),DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))",['schedule-start-'+suffix,'Schedule start']);
    ids.push(a.insertId);
    const [b]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,ends_at) VALUES(?,?,'open','free',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE))",['schedule-end-'+suffix,'Schedule end']);
    ids.push(b.insertId);
    const processed=await processCampaignSchedule();
    assert.ok(processed>=2);
    const [rows]=await pool.execute('SELECT id,status FROM campaigns WHERE id IN (?,?)',ids);
    assert.equal(rows.find(x=>Number(x.id)===Number(ids[0])).status,'open');
    assert.equal(rows.find(x=>Number(x.id)===Number(ids[1])).status,'closed');
  }finally{
    if(ids.length){await pool.execute("DELETE FROM admin_audit_log WHERE entity_type='campaign' AND entity_id IN (?,?)",ids);await pool.execute('DELETE FROM campaigns WHERE id IN (?,?)',ids);}
  }
});

test('MySQL integration: outbox marks expired sending leases uncertain without duplicate send',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');const {migrate}=await import('../../src/database/migrate.js');
  const {processNotificationOutbox}=await import('../../src/modules/notifications/outbox.worker.js');
  const chatId=String(880000000000n+(BigInt(Date.now())%100000000000n));let id;
  try{
    await migrate();
    const [r]=await pool.execute("INSERT INTO telegram_notification_outbox(chat_id,payload,status,locked_at,lease_token) VALUES(?,JSON_OBJECT('text','must not auto resend'),'sending',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 MINUTE),UUID())",[chatId]);id=r.insertId;
    let sends=0;const result=await processNotificationOutbox({sendMessage:async()=>{sends++;}});
    assert.equal(sends,0);assert.equal(result.claimed,0);
    const [[row]]=await pool.execute('SELECT status,lease_token,locked_at FROM telegram_notification_outbox WHERE id=?',[id]);
    assert.equal(row.status,'uncertain');assert.equal(row.lease_token,null);assert.equal(row.locked_at,null);
  }finally{if(id)await pool.execute('DELETE FROM telegram_notification_outbox WHERE id=?',[id]);}
});


test('MySQL integration: bank cards support CRUD, a single active default, safe deactivation and order snapshot source',{skip:!enabled},async(t)=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createPaymentCard,updatePaymentCard,setDefaultPaymentCard,setPaymentCardActive,getDefaultPaymentCard}=await import('../../src/modules/payments/bank-card.service.js');
  const suffix=String(Date.now()).slice(-12).padStart(12,'0');
  const cardA='4111'+suffix,cardB='5555'+suffix;
  let idA,idB;
  try{
    await migrate();
    const [[existing]]=await pool.execute('SELECT COUNT(*) AS total FROM payment_bank_cards');
    if(Number(existing.total)!==0){
      t.skip('Requires an empty disposable CI card table; refusing to modify pre-existing card records.');
      return;
    }
    const a=await createPaymentCard({bankName:'Integration Bank A',cardNumber:cardA,cardHolder:'Integration Holder A',instructions:'A'},'1');idA=a.id;
    const b=await createPaymentCard({bankName:'Integration Bank B',cardNumber:cardB,cardHolder:'Integration Holder B',instructions:'B'},'1');idB=b.id;
    await assert.rejects(createPaymentCard({bankName:'Duplicate Bank',cardNumber:cardA,cardHolder:'Duplicate Holder'},'1'),/قبلاً ثبت شده/);
    await setDefaultPaymentCard(idA,'1');
    await setDefaultPaymentCard(idB,'1');
    let current=await getDefaultPaymentCard();
    assert.equal(Number(current.id),idB);
    const [[defaultCount]]=await pool.execute('SELECT COUNT(*) total FROM payment_bank_cards WHERE is_default=1');
    assert.equal(Number(defaultCount.total),1);
    await setPaymentCardActive(idB,false,'1');
    current=await getDefaultPaymentCard();
    assert.ok(current,'Deactivating the default card must select another active card.');
    assert.notEqual(Number(current.id),idB,'The deactivated card must not remain the default.');
    const [[fallbackState]]=await pool.execute('SELECT is_active,is_default FROM payment_bank_cards WHERE id=?',[current.id]);
    assert.equal(Number(fallbackState.is_active),1);
    assert.equal(Number(fallbackState.is_default),1);
    const [[fallbackCount]]=await pool.execute('SELECT COUNT(*) total FROM payment_bank_cards WHERE is_active=1 AND is_default=1');
    assert.equal(Number(fallbackCount.total),1);
    await setPaymentCardActive(idB,true,'1');
    await setDefaultPaymentCard(idB,'1');
    const edited=await updatePaymentCard(idB,{bankName:'Updated Integration Bank',cardNumber:cardB,cardHolder:'Updated Integration Holder',instructions:'updated'},'1');
    assert.equal(edited.bank_name,'Updated Integration Bank');
    assert.equal(Number(edited.is_default),1);
    await setPaymentCardActive(idA,false,'1');
    await assert.rejects(setPaymentCardActive(idB,false,'1'),/ابتدا کارت دیگری اضافه/);
  }finally{
    if(idA)await pool.execute('DELETE FROM payment_bank_cards WHERE id=?',[idA]);
    if(idB)await pool.execute('DELETE FROM payment_bank_cards WHERE id=?',[idB]);
  }
});
