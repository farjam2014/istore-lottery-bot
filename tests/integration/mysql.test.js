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
    await migrate();
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
  let participantId;let campaignId;let orderId;let previousOrderId;let receiptId;let telegramId;
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
    receiptId=(await submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-1',fileUniqueId:'unique-test-'+telegramId,note:'test'})).receiptId;
    await assert.rejects(submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-2',fileUniqueId:'unique-test-'+telegramId}),/قبلاً/);
    await reviewReceipt({adminId:'1',receiptId,decision:'reject',reason:'رسید آزمایشی نامعتبر'});
    await assert.rejects(reviewReceipt({adminId:'1',receiptId,decision:'approve'}),/قبلاً/);
    const [afterReject]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[orderId]);assert.equal(afterReject[0].status,'rejected');
    const [retry]=await submitReceipt({telegramUserId:telegramId,orderId,fileId:'file-test-2',fileUniqueId:'unique-test-2-'+telegramId});
    await reviewReceipt({adminId:'1',receiptId:retry.receiptId,decision:'approve'});
    const [codes]=await pool.execute('SELECT code FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id WHERE e.campaign_id=?',[campaignId]);
    assert.equal(codes.length,2);
    await assert.rejects(reviewReceipt({adminId:'1',receiptId:retry.receiptId,decision:'approve'}),/قبلاً/);
    const [[order]]=await pool.execute('SELECT status FROM payment_orders WHERE id=?',[orderId]);assert.equal(order.status,'approved');
  }finally{
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

test.after(async()=>{if(enabled){const {pool}=await import('../../src/database/pool.js');await pool.end();}});
