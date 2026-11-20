import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateGuard} from '../../src/bot/middleware/update-guard.js';

function fakeDatabase(){
  const inbox=new Map();
  const counters=new Map();
  return {
    inbox,counters,
    async execute(sql,params=[]){
      if(sql.startsWith('INSERT IGNORE INTO telegram_update_inbox')){
        const id=params[0];
        if(inbox.has(id))return [{affectedRows:0},[]];
        inbox.set(id,{payload:params[1],status:'pending',attempts:0,lease:params[1]});
        return [{affectedRows:1},[]];
      }
      if(sql.startsWith("UPDATE telegram_update_inbox SET status='processing'")){
        const row=inbox.get(params[1]);
        if(row&&(row.status==='pending'||row.status==='failed')){
          row.status='processing';row.attempts++;row.lease=params[0];
          return [{affectedRows:1},[]];
        }
        return [{affectedRows:0},[]];
      }
      if(sql.startsWith('SELECT status FROM telegram_update_inbox')){
        const row=inbox.get(params[0]);
        return [[row?{status:row.status}:undefined].filter(Boolean),[]];
      }
      if(sql.startsWith('SELECT attempts FROM telegram_update_inbox')){
        const row=inbox.get(params[0]);
        return [[row?{attempts:row.attempts}:undefined].filter(Boolean),[]];
      }
      if(sql.startsWith('INSERT INTO telegram_rate_limits')){
        const key=params[0]+':'+params[1];
        counters.set(key,(counters.get(key)||0)+1);
        return [{affectedRows:1},[]];
      }
      if(sql.startsWith('SELECT request_count FROM telegram_rate_limits')){
        const key=params[0]+':'+params[1];
        return [[{request_count:counters.get(key)||0}],[]];
      }
      if(sql.startsWith("UPDATE telegram_update_inbox SET status='completed'")){
        const row=inbox.get(params[0]);
        if(row&&row.lease===params[1]){row.status='completed';row.lease=null;return [{affectedRows:1},[]];}
        return [{affectedRows:0},[]];
      }
      if(sql.startsWith("UPDATE telegram_update_inbox SET status='pending'")){
        const row=inbox.get(params[1]);
        if(row&&row.lease===params[2]){row.status='pending';row.lease=null;row.error=params[0];return [{affectedRows:1},[]];}
        return [{affectedRows:0},[]];
      }
      if(sql.startsWith('DELETE FROM '))return [{affectedRows:0},[]];
      throw new Error('Unexpected SQL in update-guard unit test: '+sql);
    }
  };
}

function context({id,userId='12345',text='hello',callback=false}={}){
  const ctx={
    update:{update_id:id},
    from:{id:userId},
    chat:{id:userId},
    state:{},
    replies:[],
    callbackAnswers:[],
    async reply(message){this.replies.push(message);},
    async answerCbQuery(...args){this.callbackAnswers.push(args);}
  };
  if(callback)ctx.callbackQuery={id:'callback-'+id};
  else ctx.message={text};
  return ctx;
}
const logger={warn(){},error(){}};
const identity=(_id,fn)=>fn();

test('unique update is processed once and completed duplicates are ignored',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity,uuid:()=> '12345678-uuid'});
  let calls=0;
  const first=context({id:1,callback:true});
  await guard(first,async()=>{calls++;});
  const duplicate=context({id:1,callback:true});
  await guard(duplicate,async()=>{calls++;});
  assert.equal(calls,1);
  assert.equal(duplicate.callbackAnswers.length,1);
  assert.equal(database.inbox.get(1).status,'completed');
  assert.match(first.state.correlationId,/^tg-1-/);
});

test('text rate limit allows ten updates and blocks the eleventh',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  let calls=0;
  for(let id=100;id<111;id++){
    const ctx=context({id,userId:'55555'});
    await guard(ctx,async()=>{calls++;});
    if(id===110)assert.equal(ctx.replies.length,1);
  }
  assert.equal(calls,10);
  assert.equal(database.counters.get('55555:text'),11);
});

test('rate limits are isolated by user and update category',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  let calls=0;
  for(let id=200;id<211;id++)await guard(context({id,userId:'11111'}),async()=>{calls++;});
  await guard(context({id:211,userId:'22222'}),async()=>{calls++;});
  await guard(context({id:212,userId:'11111',callback:true}),async()=>{calls++;});
  assert.equal(calls,12);
  assert.equal(database.counters.get('11111:text'),11);
  assert.equal(database.counters.get('22222:text'),1);
  assert.equal(database.counters.get('11111:callback'),1);
});

test('handler failure preserves payload and makes the update retryable',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  await assert.rejects(guard(context({id:300,userId:'33333'}),async()=>{throw new Error('handler failure');}),/handler failure/);
  const row=database.inbox.get(300);
  assert.equal(row.status,'pending');
  assert.ok(row.payload);
  assert.equal(row.lease,null);
});

test('callback and non-text buckets enforce independent limits',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  let calls=0;
  for(let id=400;id<436;id++)await guard(context({id,userId:'44444',callback:true}),async()=>{calls++;});
  for(let id=500;id<521;id++)await guard(context({id,userId:'44444',text:null}),async()=>{calls++;});
  assert.equal(calls,35+20);
  assert.equal(database.counters.get('44444:callback'),36);
  assert.equal(database.counters.get('44444:other'),21);
});

test('updates without a safe integer update id bypass inbox claiming',async()=>{
  const database={async execute(){throw new Error('database must not be called');}};
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  const ctx={update:{update_id:'not-an-integer'},state:{}};
  let calls=0;
  await guard(ctx,async()=>{calls++;});
  assert.equal(calls,1);
});
