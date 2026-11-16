import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: free campaign codes use the new sequential format under concurrency',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {joinFreeCampaign}=await import('../../src/modules/entries/entry.service.js');
  const telegramIds=[];let campaignId;
  try{
    await migrate();
    const suffix=String(Date.now());
    const [campaign]=await pool.execute(
      "INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'open','free',1)",
      [`code-format-${suffix}`,'Code format integration']
    );
    campaignId=campaign.insertId;
    for(let i=0;i<8;i++){
      const telegramId=String(600000000000n+(BigInt(Date.now())%100000000000n)+BigInt(i));
      telegramIds.push(telegramId);
      await pool.execute(
        'INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',
        [telegramId,`Code Tester ${i}`,`+9891212345${String(i).padStart(2,'0')}`,`code_test_${i}`]
      );
    }
    const results=await Promise.all(telegramIds.map(telegramUserId=>joinFreeCampaign({telegramUserId,campaignId})));
    const [rows]=await pool.execute(
      'SELECT sequence_number,code FROM campaign_codes WHERE campaign_id=? ORDER BY sequence_number',
      [campaignId]
    );
    assert.equal(rows.length,8);
    assert.deepEqual(rows.map(row=>Number(row.sequence_number)),[10001,10002,10003,10004,10005,10006,10007,10008]);
    for(const row of rows){
      assert.match(row.code,new RegExp(`^P${campaignId}-[A-Z0-9]{6}-[A-Z0-9][A-Z0]$`));
      const middle=row.code.split('-')[1],digits=String(row.sequence_number);
      assert.equal(middle.slice(-digits.length),digits);
      const randomPrefix=middle.slice(0,6-digits.length);
      if(randomPrefix)assert.match(randomPrefix.at(-1),/^[A-Z0]$/);
    }
    assert.equal(results.length,8);
  }finally{
    if(campaignId){
      await pool.execute('DELETE FROM campaign_codes WHERE campaign_id=?',[campaignId]);
      await pool.execute('DELETE FROM campaign_entries WHERE campaign_id=?',[campaignId]);
    }
    if(telegramIds.length)await pool.execute(
      `DELETE FROM participants WHERE telegram_user_id IN (${telegramIds.map(()=>'?').join(',')})`,
      telegramIds
    );
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
  }
});

test('MySQL integration: paid approval uses the same campaign code sequence',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createOrGetOrder,submitReceipt,reviewReceipt,updatePaymentSettings}=await import('../../src/modules/payments/payment.service.js');
  const telegramId=String(610000000000n+(BigInt(Date.now())%100000000000n));
  let participantId,campaignId,orderId,receiptId;
  try{
    await migrate();
    const [p]=await pool.execute(
      'INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',
      [telegramId,'Paid Code Tester','+989121234599','paid_code_test']
    );
    participantId=p.insertId;
    const [c]=await pool.execute(
      "INSERT INTO campaigns(slug,title,status,participation_type,entry_price,codes_per_entry) VALUES(?,?,'open','paid',100000,2)",
      [`paid-code-${telegramId}`,'Paid code integration']
    );
    campaignId=c.insertId;
    await updatePaymentSettings({bankName:'Code CI Bank',cardNumber:'1234567812345678',cardHolder:'Code CI Holder',instructions:'',adminId:'1'});
    const order=await createOrGetOrder({telegramUserId:telegramId,campaignId});
    orderId=order.order.id;
    const receipt=await submitReceipt({
      telegramUserId:telegramId,orderId,fileId:`code-file-${telegramId}`,
      fileUniqueId:`code-unique-${telegramId}`
    });
    receiptId=receipt.receiptId;
    await reviewReceipt({adminId:'1',receiptId,decision:'approve'});
    const [rows]=await pool.execute(
      'SELECT sequence_number,code FROM campaign_codes WHERE campaign_id=? ORDER BY sequence_number',
      [campaignId]
    );
    assert.equal(rows.length,2);
    assert.deepEqual(rows.map(row=>Number(row.sequence_number)),[10001,10002]);
    for(const row of rows)assert.match(row.code,new RegExp(`^P${campaignId}-[A-Z0-9]{6}-[A-Z0-9][A-Z0]$`));
  }finally{
    if(orderId){
      await pool.execute('DELETE FROM telegram_notification_outbox WHERE chat_id=?',[telegramId]);
      await pool.execute('DELETE FROM payment_events WHERE order_id=?',[orderId]);
      await pool.execute('DELETE FROM payment_receipts WHERE order_id=?',[orderId]);
      await pool.execute('DELETE FROM payment_orders WHERE id=?',[orderId]);
    }
    if(participantId){
      const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[participantId]);
      for(const entry of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[entry.id]);
      await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[participantId]);
      await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
    }
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
  }
});

test.after(async()=>{if(enabled){const {pool}=await import('../../src/database/pool.js');await pool.end();}});
