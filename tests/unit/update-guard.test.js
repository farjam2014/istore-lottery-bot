import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateGuard} from '../../src/bot/middleware/update-guard.js';

function fakeDatabase(){
  const processed=new Set();
  const counters=new Map();
  return {
    processed,
    counters,
    async execute(sql,params=[]){
      if(sql.startsWith('INSERT IGNORE INTO processed_updates')){
        const id=params[0];
        if(processed.has(id))return [{affectedRows:0},[]];
        processed.add(id);
        return [{affectedRows:1},[]];
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
      if(sql.startsWith('DELETE FROM processed_updates WHERE update_id=')){
        processed.delete(params[0]);
        return [{affectedRows:1},[]];
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

test('update guard processes a unique update once and acknowledges duplicate callbacks',async()=>{
  const database=fakeDatabase();
  const guard=createUpdateGuard({database,log:logger,correlate:identity,uuid:()=> '12345678-uuid'});
  let calls=0;
  const first=context({id:1,callback:true});
  await guard(first,async()=>{calls++;});
  const duplicate=context({id:1,callback:true});
  await guard(duplicate,async()=>{calls++;});
  assert.equal(calls,1);
  assert.equal(duplicate.callbackAnswers.length,1);
  assert.equal(database.processed.has(1),true);
  assert.match(first.state.correlationId,/^tg-1-/);
});

test('text rate limit allows ten updates and blocks the eleventh in the same window',async()=>{
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
  for(let id=200;id<211;id++){
    await guard(context({id,userId:'11111'}),async()=>{calls++;});
  }
  await guard(context({id:211,userId:'22222'}),async()=>{calls++;});
  await guard(context({id:212,userId:'11111',callback:true}),async()=>{calls++;});
  assert.equal(calls,12);
  assert.equal(database.counters.get('11111:text'),11);
  assert.equal(database.counters.get('22222:text'),1);
  assert.equal(database.counters.get('11111:callback'),1);
});

test('database failure after claiming an update releases the idempotency claim',async()=>{
  const database=fakeDatabase();
  const original=database.execute.bind(database);
  database.execute=async(sql,params)=>{
    if(sql.startsWith('SELECT request_count'))throw new Error('simulated database failure');
    return original(sql,params);
  };
  const guard=createUpdateGuard({database,log:logger,correlate:identity});
  await assert.rejects(
    guard(context({id:300,userId:'33333'}),async()=>{}),
    /simulated database failure/
  );
  assert.equal(database.processed.has(300),false);
});
