import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';
test('uncertain retry confirmation is snapshot-bound, transactional and idempotent under concurrent clicks',{skip:!enabled},async()=>{
  assert.match(process.env.MYSQL_DATABASE||'',/_ci$|_test$/);
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {retryUncertainNotifications}=await import('../../src/modules/notifications/uncertain-retry.service.js');
  const adminId='900000001';
  const chats=[String(730000000000n+BigInt(Date.now()%100000000000)),String(740000000000n+BigInt(Date.now()%100000000000))];
  const ids=[];
  try{
    await migrate();
    const [[before]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE status='uncertain'");
    assert.equal(Number(before.total),0);
    for(const chat of chats){
      const [r]=await pool.execute("INSERT INTO telegram_notification_outbox(chat_id,payload,status) VALUES(?,JSON_OBJECT('text','retry test'),'uncertain')",[chat]);
      ids.push(String(r.insertId));
    }
    const maxId=ids[ids.length-1];
    const stale=await retryUncertainNotifications({adminId,expectedCount:1,expectedMaxId:maxId});
    assert.equal(stale.confirmed,false);
    const results=await Promise.all([
      retryUncertainNotifications({adminId,expectedCount:2,expectedMaxId:maxId}),
      retryUncertainNotifications({adminId,expectedCount:2,expectedMaxId:maxId})
    ]);
    assert.equal(results.filter(x=>x.confirmed).length,1);
    const [[counts]]=await pool.execute("SELECT SUM(status='pending') pending,SUM(manual_retry_count=1) retried FROM telegram_notification_outbox WHERE id IN (?,?)",ids);
    assert.equal(Number(counts.pending),2);
    assert.equal(Number(counts.retried),2);
    const [[audit]]=await pool.execute("SELECT details FROM admin_audit_log WHERE admin_telegram_id=? AND action='system.outbox_retry_uncertain' ORDER BY id DESC LIMIT 1",[adminId]);
    const details=typeof audit.details==='string'?JSON.parse(audit.details):audit.details;
    assert.equal(details.count,2);
    await assert.rejects(retryUncertainNotifications({adminId,expectedCount:0,expectedMaxId:maxId}),/Invalid/);
  }finally{
    if(ids.length)await pool.execute('DELETE FROM telegram_notification_outbox WHERE id IN (?,?)',ids);
    await pool.execute("DELETE FROM admin_audit_log WHERE admin_telegram_id=? AND action='system.outbox_retry_uncertain'",[adminId]);
  }
});
