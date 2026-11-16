import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: ambiguous Telegram errors become uncertain, 429 retries and permanent 4xx fails',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Outbox delivery integration must use an isolated test database');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {processNotificationOutbox}=await import('../../src/modules/notifications/outbox.worker.js');
  const suffix=String(Date.now()).slice(-10);
  const cases=[
    {key:'429',error:Object.assign(new Error('Too Many Requests'),{response:{error_code:429,parameters:{retry_after:12}}}),expected:'pending'},
    {key:'400',error:Object.assign(new Error('Bad Request'),{response:{error_code:400,description:'Bad Request'}}),expected:'failed'},
    {key:'500',error:Object.assign(new Error('Internal Server Error'),{response:{error_code:500,description:'Internal Server Error'}}),expected:'uncertain'},
    {key:'network',error:new Error('socket hang up'),expected:'uncertain'}
  ];
  const ids=[];
  try{
    await migrate();
    const [[pendingBefore]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE status='pending' AND available_at<=UTC_TIMESTAMP()");
    assert.equal(Number(pendingBefore.total),0,'The isolated test database must not contain runnable pending outbox rows before this scenario');
    const outcomes=new Map();
    for(const item of cases){
      const chatId=String(770000000000n+(BigInt(suffix)*100n)+BigInt(ids.length+1));
      outcomes.set(chatId,item.error);
      const [row]=await pool.execute(
        "INSERT INTO telegram_notification_outbox(chat_id,payload,status,available_at) VALUES(?,JSON_OBJECT('text',?),'pending',UTC_TIMESTAMP())",
        [chatId,'delivery-outcome-'+item.key]
      );
      ids.push({id:String(row.insertId),chatId,...item});
    }
    const telegram={sendMessage:async chatId=>{throw outcomes.get(String(chatId));}};
    const result=await processNotificationOutbox(telegram,{limit:cases.length});
    assert.equal(result.claimed,4);
    assert.equal(result.delivered,0);
    assert.equal(result.failed,2);
    assert.equal(result.uncertain,2);

    for(const item of ids){
      const [[row]]=await pool.execute(
        'SELECT status,attempts,available_at,locked_at,lease_token,last_error FROM telegram_notification_outbox WHERE id=?',
        [item.id]
      );
      assert.equal(row.status,item.expected,item.key+' delivery classification');
      assert.equal(Number(row.attempts),1);
      assert.equal(row.locked_at,null);
      assert.equal(row.lease_token,null);
      assert.ok(String(row.last_error).length>0);
      if(item.key==='429'){
        const [[delay]]=await pool.execute('SELECT TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),available_at) seconds FROM telegram_notification_outbox WHERE id=?',[item.id]);
        assert.ok(Number(delay.seconds)>=10,'429 retry_after must be respected');
      }
    }
  }finally{
    if(ids.length){
      const placeholders=ids.map(()=>'?').join(',');
      await pool.execute('DELETE FROM telegram_notification_outbox WHERE id IN ('+placeholders+')',ids.map(x=>x.id));
    }
  }
});

test.after(async()=>{
  if(enabled){
    const {pool}=await import('../../src/database/pool.js');
    await pool.end();
  }
});
