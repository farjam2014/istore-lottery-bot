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
    telegramId=String(700000000000n+BigInt(Date.now()%100000000000n));
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
    await pool.end();
  }
});


test('MySQL integration: paid order receipt review is idempotent and codes issue only after approval',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createOrGetOrder,submitReceipt,reviewReceipt,updatePaymentSettings}=await import('../../src/modules/payments/payment.service.js');
  let participantId;let campaignId;let orderId;let receiptId;let telegramId;
  try{
    await migrate();
    telegramId=String(800000000000n+BigInt(Date.now()%100000000000n));
    const [p]=await pool.execute("INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)",[telegramId,'Paid Integration','+989121111111','paid_test']);participantId=p.insertId;
    const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'open','paid',150000,2)",['paid-it-'+telegramId,'Paid integration']);campaignId=c.insertId;
    await updatePaymentSettings({bankName:'Test Bank',cardNumber:'1234567812345678',cardHolder:'Test Holder',instructions:'',adminId:'1'});
    const created=await createOrGetOrder({telegramUserId:telegramId,campaignId});orderId=created.order.id;
    assert.equal(Number(created.order.amount),150000);
    const before=await pool.execute('SELECT COUNT(*) total FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id WHERE e.campaign_id=?',[campaignId]);
    assert.equal(Number(before[0][0].total),0);
    const repeated=await createOrGetOrder({telegramUserId:telegramId,campaignId});assert.equal(repeated.order.id,orderId);
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
    if(orderId){await pool.execute('DELETE FROM payment_events WHERE order_id=?',[orderId]);await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[orderId]);}
    if(participantId){const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[participantId]);for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[participantId]);await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);}
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    await pool.end();
  }
});
