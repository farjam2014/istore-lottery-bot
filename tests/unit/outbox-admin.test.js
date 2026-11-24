import test from 'node:test';
import assert from 'node:assert/strict';
import {retryOutboxNotification} from '../../src/modules/notifications/outbox-admin.service.js';

function fakeDatabase({status='uncertain',auditFails=false}={}){
  const state={row:{id:7,status,attempts:3,manual_retry_count:1},updates:0,audits:0,commits:0,rollbacks:0,releases:0};
  const connection={
    async beginTransaction(){},
    async commit(){state.commits++;},
    async rollback(){state.rollbacks++;},
    release(){state.releases++;},
    async execute(sql,params=[]){
      if(sql.startsWith('SELECT id,status,attempts,manual_retry_count')){
        return [[state.row?{...state.row}:undefined].filter(Boolean),[]];
      }
      if(sql.startsWith("UPDATE telegram_notification_outbox SET status='pending'")){
        state.updates++;
        if(state.row&&state.row.status===params[2]){
          state.row.status='pending';state.row.attempts=0;state.row.manual_retry_count++;
        }
        return [{affectedRows:1},[]];
      }
      if(sql.startsWith('INSERT INTO admin_audit_log')){
        state.audits++;
        if(auditFails)throw new Error('audit unavailable');
        return [{affectedRows:1},[]];
      }
      throw new Error('Unexpected SQL '+sql);
    }
  };
  return {state,async getConnection(){return connection;}};
}

test('manual outbox retry requeues only the reviewed item and writes audit atomically',async()=>{
  const database=fakeDatabase({status:'uncertain'});
  const result=await retryOutboxNotification({notificationId:7,adminId:'99',expectedStatus:'uncertain',database});
  assert.deepEqual(result,{notificationId:7,previousStatus:'uncertain'});
  assert.equal(database.state.row.status,'pending');
  assert.equal(database.state.updates,1);
  assert.equal(database.state.audits,1);
  assert.equal(database.state.commits,1);
});

test('manual outbox retry rejects stale status without changing the row',async()=>{
  const database=fakeDatabase({status:'sent'});
  await assert.rejects(retryOutboxNotification({notificationId:7,adminId:'99',expectedStatus:'uncertain',database}),/وضعیت اعلان/);
  assert.equal(database.state.updates,0);
  assert.equal(database.state.audits,0);
  assert.equal(database.state.rollbacks,1);
});

test('manual outbox retry rolls back the queue change when audit fails',async()=>{
  const database=fakeDatabase({status:'failed',auditFails:true});
  await assert.rejects(retryOutboxNotification({notificationId:7,adminId:'99',expectedStatus:'failed',database}),/audit unavailable/);
  assert.equal(database.state.updates,1);
  assert.equal(database.state.audits,1);
  assert.equal(database.state.commits,0);
  assert.equal(database.state.rollbacks,1);
});

test('manual outbox retry rejects invalid status',async()=>{
  const database=fakeDatabase({status:'pending'});
  await assert.rejects(retryOutboxNotification({notificationId:7,adminId:'99',expectedStatus:'pending',database}),/Only failed or uncertain/);
  assert.equal(database.state.updates,0);
});
