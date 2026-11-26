import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createUpdateGuard} from '../../src/bot/middleware/update-guard.js';

function fakeDatabase(){
  const inbox=new Map();
  const counters=new Map();
  let heartbeatCount=0;
  return {
    inbox,counters,get heartbeatCount(){return heartbeatCount;},
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
      if(sql.startsWith("UPDATE telegram_update_inbox SET status='failed'")){
        const row=inbox.get(params[2]);
        if(row&&row.lease===params[3]){row.status='failed';row.lease=null;row.error=params[1];row.availableDelay=params[0];return [{affectedRows:1},[]];}
        return [{affectedRows:0},[]];
      }
      if(sql.startsWith("UPDATE telegram_update_inbox SET locked_at=UTC_TIMESTAMP()")){
        const row=inbox.get(params[0]);
        if(row&&row.lease===params[1])heartbeatCount++;
        return [{affectedRows:row&&row.lease===params[1]?1:0},[]];
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

test('handler failure preserves payload, enters bounded retry state and never logs raw exception text',async()=>{
  const database=fakeDatabase();
  const emitted=[];
  const log={warn(data,message){emitted.push({data,message});},error(data,message){emitted.push({data,message});}};
  const guard=createUpdateGuard({database,log,correlate:identity});
  const secretError='handler failure phone +989121234567 receipt SECRET-INBOX';
  await assert.rejects(guard(context({id:300,userId:'33333'}),async()=>{throw new Error(secretError);}),/handler failure/);
  const row=database.inbox.get(300);
  assert.equal(row.status,'failed');
  assert.equal(row.error,'handler_failed','raw handler exception text must never be persisted in the inbox');
  assert.ok(row.payload);
  assert.equal(row.lease,null);
  assert.ok(row.availableDelay>0);
  assert.equal(JSON.stringify(emitted).includes(secretError),false,'raw handler exception must not be logged');
  assert.deepEqual(emitted[0].data,{reason:'handler_failed',updateId:300});
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


test('long-running handler renews its lease before it expires',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity,heartbeatIntervalMs:5,leaseMinutes:1});
  await guard(context({id:900,userId:'99999'}),async()=>new Promise(resolve=>setTimeout(resolve,25)));
  assert.ok(database.heartbeatCount>=1,'expected at least one lease heartbeat');
  assert.equal(database.inbox.get(900).status,'completed');
});


test('failed callback updates are not replayed after callback query expiry',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  const first=context({id:901,userId:'12345',callback:true});
  await assert.rejects(guard(first,async()=>{throw new Error('stale callback failure');}),/stale callback failure/);
  assert.equal(database.inbox.get(901).status,'failed');

  const replay=context({id:901,userId:'12345',callback:true});
  let calls=0;
  await guard(replay,async()=>{calls++;});
  assert.equal(calls,0,'expired callback handlers must not be executed again');
  assert.equal(replay.state.durableReplay,true);
  assert.equal(database.inbox.get(901).status,'completed');
});


test('expired callback acknowledgement does not abort a fresh callback handler',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  const ctx=context({id:902,userId:'12345',callback:true});
  ctx.answerCbQuery=async()=>{throw Object.assign(new Error('400: Bad Request: query is too old and response timeout expired or query ID is invalid'),{response:{error_code:400}});};
  let calls=0;
  await guard(ctx,async()=>{await ctx.answerCbQuery();calls++;});
  assert.equal(calls,1,'business handler should continue when only callback acknowledgement expired');
  assert.equal(database.inbox.get(902).status,'completed');
});

test('an existing inbox update is marked as durable replay on its first recovery claim',async()=>{
  const database=fakeDatabase();
  database.inbox.set(950,{payload:JSON.stringify({update_id:950}),status:'pending',attempts:0,lease:null});
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  const ctx=context({id:950,userId:'12345'});
  let durableReplay=false;
  await guard(ctx,async()=>{durableReplay=ctx.state.durableReplay;});
  assert.equal(durableReplay,true);
  assert.equal(database.inbox.get(950).status,'completed');
});


test('lease heartbeat and release failures log fixed labels without exception contents',async()=>{
  const secretHeartbeat='heartbeat database error phone +989121234567 SECRET-HEARTBEAT';
  const secretRelease='lease release database error receipt SECRET-RELEASE';
  const emitted=[];
  const log={warn(data,message){emitted.push({data,message});},error(data,message){emitted.push({data,message});}};

  const heartbeatDatabase=fakeDatabase();
  const heartbeatExecute=heartbeatDatabase.execute.bind(heartbeatDatabase);
  heartbeatDatabase.execute=async(sql,params=[])=>{
    if(sql.startsWith('UPDATE telegram_update_inbox SET locked_at=UTC_TIMESTAMP()'))throw new Error(secretHeartbeat);
    return heartbeatExecute(sql,params);
  };
  const heartbeatGuard=createUpdateGuard({database:heartbeatDatabase,log,correlate:identity,heartbeatIntervalMs:1});
  await heartbeatGuard(context({id:951,userId:'95100'}),async()=>new Promise(resolve=>setTimeout(resolve,15)));

  const releaseDatabase=fakeDatabase();
  const releaseExecute=releaseDatabase.execute.bind(releaseDatabase);
  releaseDatabase.execute=async(sql,params=[])=>{
    if(sql.startsWith("UPDATE telegram_update_inbox SET status='failed'"))throw new Error(secretRelease);
    return releaseExecute(sql,params);
  };
  const releaseGuard=createUpdateGuard({database:releaseDatabase,log,correlate:identity});
  await assert.rejects(releaseGuard(context({id:952,userId:'95200'}),async()=>{throw new Error('business handler failure');}),/business handler failure/);

  const serialized=JSON.stringify(emitted);
  assert.equal(serialized.includes(secretHeartbeat),false);
  assert.equal(serialized.includes(secretRelease),false);
  assert.ok(emitted.some(entry=>entry.data.reason==='lease_heartbeat_failed'));
  assert.ok(emitted.some(entry=>entry.data.reason==='handler_failed'));
  assert.ok(emitted.some(entry=>entry.data.reason==='lease_release_failed'));
});

test('private-chat filter runs before durable inbox persistence',()=>{
  const register=readFileSync(new URL('../../src/bot/register.js',import.meta.url),'utf8');
  assert.ok(register.indexOf('bot.use(privateChatOnly)')>=0);
  assert.ok(register.indexOf('bot.use(updateGuard())')>=0);
  assert.ok(register.indexOf('bot.use(privateChatOnly)')<register.indexOf('bot.use(updateGuard())'));
});
