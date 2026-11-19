import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateInboxWorker} from '../../src/bot/update-inbox.worker.js';

test('recovery worker replays stored payloads through bot.handleUpdate',async()=>{
  const rows=[
    {update_id:1,payload:JSON.stringify({update_id:1,message:{text:'/start'}})},
    {update_id:2,payload:{update_id:2,callback_query:{id:'cb'}}}
  ];
  const calls=[];
  const database={async execute(sql,params){
    assert.match(sql,/telegram_update_inbox/);
    assert.equal(params[0],2);
    return [rows,[]];
  }};
  const worker=createUpdateInboxWorker({database,log:{error(){}}});
  const bot={async handleUpdate(update){calls.push(update.update_id);}};
  const result=await worker(bot,{limit:2});
  assert.deepEqual(calls,[1,2]);
  assert.deepEqual(result,{claimed:2,replayed:2,failed:0});
});

test('recovery worker reports malformed payload and continues',async()=>{
  const rows=[
    {update_id:1,payload:'not-json'},
    {update_id:2,payload:JSON.stringify({update_id:2})}
  ];
  const calls=[];
  const database={async execute(){return [rows,[]];}};
  const worker=createUpdateInboxWorker({database,log:{error(){}}});
  const bot={async handleUpdate(update){calls.push(update.update_id);}};
  const result=await worker(bot);
  assert.deepEqual(calls,[2]);
  assert.deepEqual(result,{claimed:2,replayed:1,failed:1});
});
