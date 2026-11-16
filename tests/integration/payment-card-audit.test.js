import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: bank-card changes and audit events commit together without exposing full card numbers',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Payment-card audit integration must use an isolated database');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createPaymentCard,updatePaymentCard}=await import('../../src/modules/payments/bank-card.service.js');
  const adminId=String(970000000000n+(BigInt(Date.now())%100000000000n));
  const suffix=BigInt(Date.now())%1000000000000000n;
  const cardNumber=String(7000000000000000n+suffix);
  const updatedCardNumber=String(8000000000000000n+suffix);
  let cardId;
  try{
    await migrate();
    const created=await createPaymentCard({bankName:'Test Bank',cardNumber,cardHolder:'Test Holder',instructions:'Audit test'},adminId);
    cardId=created.id;
    await updatePaymentCard(cardId,{bankName:'Updated Test Bank',cardNumber:updatedCardNumber,cardHolder:'Updated Test Holder',instructions:'Updated audit test'},adminId);
    const [events]=await pool.execute(
      "SELECT action,details FROM admin_audit_log WHERE admin_telegram_id=? AND entity_type='payment_bank_card' AND entity_id=? AND action IN ('payment_card.created','payment_card.updated') ORDER BY id",
      [adminId,cardId]
    );
    assert.deepEqual(events.map(x=>x.action),['payment_card.created','payment_card.updated']);
    for(const event of events){
      const details=typeof event.details==='string'?JSON.parse(event.details):event.details;
      assert.ok(details.cardLast4);
      assert.ok(!JSON.stringify(details).includes(cardNumber),'Audit details must not contain the full original card number');
      assert.ok(!JSON.stringify(details).includes(updatedCardNumber),'Audit details must not contain the full updated card number');
    }
    await assert.rejects(
      createPaymentCard({bankName:'Duplicate Bank',cardNumber:updatedCardNumber,cardHolder:'Duplicate Holder'},adminId),
      /قبلاً ثبت شده/
    );
    const [[count]]=await pool.execute(
      "SELECT COUNT(*) total FROM admin_audit_log WHERE admin_telegram_id=? AND entity_type='payment_bank_card' AND entity_id=? AND action IN ('payment_card.created','payment_card.updated')",
      [adminId,cardId]
    );
    assert.equal(Number(count.total),2,'A rejected duplicate insert must not create an audit event');
  }finally{
    if(cardId){
      const [[card]]=await pool.execute('SELECT is_default FROM payment_bank_cards WHERE id=?',[cardId]);
      if(card&&Number(card.is_default)!==1){
        await pool.execute("DELETE FROM admin_audit_log WHERE admin_telegram_id=? AND entity_type='payment_bank_card' AND entity_id=?",[adminId,cardId]);
        await pool.execute('DELETE FROM payment_bank_cards WHERE id=?',[cardId]);
      }
    }
  }
});

test.after(async()=>{
  if(enabled){
    const {pool}=await import('../../src/database/pool.js');
    await pool.end();
  }
});
