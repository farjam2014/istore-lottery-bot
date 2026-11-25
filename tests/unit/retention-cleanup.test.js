import test from 'node:test';
import assert from 'node:assert/strict';
import {createRetentionCleanupWorker} from '../../src/modules/privacy/retention-cleanup.worker.js';

test('retention worker purges expired participant, admin, support, and operational session rows in bounded batches',async()=>{
  const statements=[];
  const worker=createRetentionCleanupWorker({database:{execute:async(sql)=>{statements.push(sql);return [{affectedRows:2}];}}});
  const result=await worker();
  assert.equal(result.deleted,20);
  assert.equal(Object.keys(result.byTable).length,10);
  for(const table of ['telegram_user_sessions','admin_wizards','payment_card_admin_sessions','payment_admin_sessions','admin_search_sessions','admin_role_sessions','support_sessions','profile_change_sessions','processed_updates','telegram_rate_limits']){
    assert.ok(statements.some(sql=>sql.includes('DELETE FROM '+table)),'missing cleanup for '+table);
  }
  assert.ok(statements.every(sql=>sql.endsWith('LIMIT 500')),'each cleanup statement must be bounded');
  assert.ok(statements.some(sql=>sql.includes('admin_search_sessions')&&sql.includes('INTERVAL 24 HOUR')));
  assert.ok(statements.some(sql=>sql.includes('telegram_user_sessions')&&sql.includes('INTERVAL 24 HOUR')));
  assert.ok(statements.some(sql=>sql.includes('processed_updates')&&sql.includes('INTERVAL 3 DAY')));
  assert.ok(statements.some(sql=>sql.includes('telegram_rate_limits')&&sql.includes('INTERVAL 1 DAY')));
});

test('retention worker fails closed when a cleanup statement fails',async()=>{
  let calls=0;
  const worker=createRetentionCleanupWorker({database:{execute:async()=>{calls++;if(calls===3)throw new Error('database unavailable');return [{affectedRows:0}];}}});
  await assert.rejects(worker(),/database unavailable/);
  assert.equal(calls,3);
});
