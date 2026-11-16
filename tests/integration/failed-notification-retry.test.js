import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: failed notification retries are snapshot-bound, batch-limited, serialized and audited',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Failed retry integration must use an isolated test database');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {previewFailedNotifications,retryFailedNotifications}=await import('../../src/modules/notifications/failed-retry.service.js');
  const adminId='900000002';
  const chatBase=780000000000n+(BigInt(Date.now())%100000000000n)*1000n;
  const ids=[];
  try{
    await migrate();
    const [[existing]]=await pool.execute("SELECT COUNT(*) total FROM telegram_notification_outbox WHERE status='failed'");
    assert.equal(Number(existing.total),0,'The isolated test database must start without failed outbox rows');

    for(let i=0;i<102;i++){
      const [row]=await pool.execute(
        "INSERT INTO telegram_notification_outbox(chat_id,payload,status,last_error) VALUES(?,JSON_OBJECT('text',?),'failed',?)",
        [String(chatBase+BigInt(i)),'failed-retry-'+i,'x'.repeat(500)]
      );
      ids.push(String(row.insertId));
    }

    const firstPreview=await previewFailedNotifications();
    assert.equal(firstPreview.count,102);
    assert.equal(firstPreview.batchCount,100);
    assert.match(firstPreview.batchHash,/^[a-f0-9]{16}$/);

    const staleCount=await retryFailedNotifications({
      adminId,expectedCount:101,expectedMaxId:firstPreview.maxId,expectedBatchHash:firstPreview.batchHash
    });
    assert.equal(staleCount.confirmed,false,'A changed failed count must invalidate the preview');

    const [extra]=await pool.execute(
      "INSERT INTO telegram_notification_outbox(chat_id,payload,status,last_error) VALUES(?,JSON_OBJECT('text','arrived-after-preview'),'failed','late failure')",
      [String(chatBase+BigInt(102))]
    );
    ids.push(String(extra.insertId));
    const staleQueue=await retryFailedNotifications({
      adminId,expectedCount:firstPreview.count,expectedMaxId:firstPreview.maxId,expectedBatchHash:firstPreview.batchHash
    });
    assert.equal(staleQueue.confirmed,false,'A newer failed row must invalidate the previous snapshot');

    const preview=await previewFailedNotifications();
    assert.equal(preview.count,103);
    assert.equal(preview.batchCount,100);
    const confirmations=await Promise.all([
      retryFailedNotifications({adminId,expectedCount:preview.count,expectedMaxId:preview.maxId,expectedBatchHash:preview.batchHash}),
      retryFailedNotifications({adminId,expectedCount:preview.count,expectedMaxId:preview.maxId,expectedBatchHash:preview.batchHash})
    ]);
    assert.equal(confirmations.filter(item=>item.confirmed).length,1,'Concurrent confirmations must only retry the batch once');
    const result=confirmations.find(item=>item.confirmed);
    assert.equal(result.count,100);
    assert.equal(result.remaining,3);

    const placeholders=ids.map(()=>'?').join(',');
    const [rows]=await pool.execute(
      'SELECT id,status,manual_retry_count,last_error FROM telegram_notification_outbox WHERE id IN ('+placeholders+') ORDER BY id',
      ids
    );
    assert.equal(rows.length,103);
    const pending=rows.filter(row=>row.status==='pending');
    const failed=rows.filter(row=>row.status==='failed');
    assert.equal(pending.length,100);
    assert.equal(failed.length,3);
    assert.ok(pending.every(row=>Number(row.manual_retry_count)===1&&String(row.last_error).includes('manually retried by '+adminId)&&String(row.last_error).length<=500));
    assert.ok(failed.every(row=>Number(row.manual_retry_count)===0));

    const [[audit]]=await pool.execute(
      "SELECT details FROM admin_audit_log WHERE admin_telegram_id=? AND action='system.outbox_retry_failed' AND entity_type='notification_outbox' ORDER BY id DESC LIMIT 1",
      [adminId]
    );
    assert.ok(audit,'Successful failed retry must write an audit record');
    const details=typeof audit.details==='string'?JSON.parse(audit.details):audit.details;
    assert.equal(Number(details.count),100);
    assert.equal(Number(details.observedFailedCount),103);
    assert.equal(Number(details.batchLimit),100);
    assert.equal(String(details.expectedMaxId),preview.maxId);
    assert.equal(details.batchHash,preview.batchHash);

    const repeated=await retryFailedNotifications({
      adminId,expectedCount:preview.count,expectedMaxId:preview.maxId,expectedBatchHash:preview.batchHash
    });
    assert.equal(repeated.confirmed,false,'A confirmation token must not be reusable after its batch has been retried');
    await assert.rejects(
      retryFailedNotifications({adminId:'invalid',expectedCount:1,expectedMaxId:'1',expectedBatchHash:'0'.repeat(16)}),
      /Invalid failed notification retry confirmation/
    );
  }finally{
    if(ids.length){
      const placeholders=ids.map(()=>'?').join(',');
      await pool.execute('DELETE FROM telegram_notification_outbox WHERE id IN ('+placeholders+')',ids);
    }
    await pool.execute("DELETE FROM admin_audit_log WHERE admin_telegram_id=? AND action='system.outbox_retry_failed' AND entity_type='notification_outbox'",[adminId]);
  }
});

test.after(async()=>{
  if(enabled){
    const {pool}=await import('../../src/database/pool.js');
    await pool.end();
  }
});
