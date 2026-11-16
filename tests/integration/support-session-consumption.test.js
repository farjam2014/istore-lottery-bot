import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: concurrent support updates cannot consume one support session twice',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Support-session integration must use an isolated test database');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {lockSupportSession}=await import('../../src/modules/support/support-session.service.js');
  const telegramUserId=String(960000000000n+(BigInt(Date.now())%100000000000n));
  const first=await pool.getConnection();
  const second=await pool.getConnection();
  let firstOpen=false,secondOpen=false;
  try{
    await migrate();
    await pool.execute(
      "INSERT INTO support_sessions(telegram_user_id,step,category) VALUES(?,'new_message','other') ON DUPLICATE KEY UPDATE step='new_message',ticket_id=NULL,category='other'",
      [telegramUserId]
    );

    await first.beginTransaction();firstOpen=true;
    const consumed=await lockSupportSession(first,{telegramUserId,step:'new_message'});
    assert.ok(consumed);
    assert.equal(consumed.step,'new_message');

    const concurrent=(async()=>{
      await second.beginTransaction();secondOpen=true;
      const duplicate=await lockSupportSession(second,{telegramUserId,step:'new_message'});
      if(duplicate)await second.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[telegramUserId]);
      await second.commit();secondOpen=false;
      return duplicate;
    })();

    await first.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[telegramUserId]);
    await first.commit();firstOpen=false;

    const duplicate=await concurrent;
    assert.equal(duplicate,null,'The second concurrent update must observe that the session was already consumed');
    const [[remaining]]=await pool.execute('SELECT COUNT(*) total FROM support_sessions WHERE telegram_user_id=?',[telegramUserId]);
    assert.equal(Number(remaining.total),0);
  }finally{
    if(firstOpen)await first.rollback();
    if(secondOpen)await second.rollback();
    await pool.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[telegramUserId]);
    first.release();second.release();
  }
});

test.after(async()=>{
  if(enabled){
    const {pool}=await import('../../src/database/pool.js');
    await pool.end();
  }
});
