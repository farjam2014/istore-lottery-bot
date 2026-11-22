import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateInboxWorker} from '../../src/bot/update-inbox.worker.js';

test('recovery worker replays stored payloads and counts only completed updates',async()=>{
  const rows=[
    {update_id:1,payload:JSON.stringify({update_id:1,message:{text:'/start'}}),attempts:1},
    {update_id:2,payload:{update_id:2,callback_query:{id:'cb'}},attempts:1}
  ];
  const calls=[],cleanup=[];
  const database={async execute(sql,params=[]){
    if(sql.startsWith('DELETE FROM telegram_update_inbox')){cleanup.push(sql);return [{affectedRows:0},[]];}
    if(sql.startsWith('SELECT update_id,payload,attempts')){assert.equal(params[0],2);return [rows,[]];}
    if(sql.startsWith('SELECT status FROM telegram_update_inbox'))return [[{status:'completed'}],[]];
    throw new Error('Unexpected SQL: '+sql);
  }};
  const worker=createUpdateInboxWorker({database,log:{error(){}}});
  const bot={async handleUpdate(update){calls.push(update.update_id);}};
  const result=await worker(bot,{limit:2});
  assert.deepEqual(calls,[1,2]);
  assert.equal(cleanup.length,4,'worker must enforce completed, failed, pending and stale-processing retention');
  assert.deepEqual(result,{scanned:2,replayed:2,failed:0,skipped:0});
});

test('malformed payloads are quarantined with bounded retry metadata and worker continues',async()=>{
  const rows=[
    {update_id:1,payload:'not-json',attempts:7},
    {update_id:2,payload:JSON.stringify({update_id:2}),attempts:1}
  ];
  const calls=[],updates=[];
  const database={async execute(sql,params=[]){
    if(sql.startsWith('DELETE FROM telegram_update_inbox'))return [{affectedRows:0},[]];
    if(sql.startsWith('SELECT update_id,payload,attempts'))return [rows,[]];
    if(sql.startsWith("UPDATE telegram_update_inbox SET status='failed'")){
      updates.push({params,sql});return [{affectedRows:1},[]];
    }
    if(sql.startsWith('SELECT status FROM telegram_update_inbox'))return [[{status:'completed'}],[]];
    throw new Error('Unexpected SQL: '+sql);
  }};
  const worker=createUpdateInboxWorker({database,log:{error(){}}});
  const bot={async handleUpdate(update){calls.push(update.update_id);}};
  const result=await worker(bot);
  assert.deepEqual(calls,[2]);
  assert.deepEqual(result,{scanned:2,replayed:1,failed:1,skipped:0});
  assert.equal(updates.length,1);
  assert.equal(updates[0].params[0],30*24*60*60,'attempt 8 must receive terminal backoff');
  assert.match(updates[0].params[1],/Inbox payload\/update ID mismatch|Unexpected end|JSON/);
});
