import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminUpdateLock} from '../../src/bot/middleware/admin-update-lock.js';

function fakeLockDatabase(){
  const tails=new Map();
  return {
    async getConnection(){
      let releaseLock=null;
      return {
        async execute(sql,params=[]){
          if(sql.startsWith('SELECT GET_LOCK')){
            const name=params[0],previous=tails.get(name)||Promise.resolve();
            let releaseGate;
            const gate=new Promise(resolve=>{releaseGate=resolve;});
            const tail=previous.then(()=>gate);
            tails.set(name,tail);
            await previous;
            releaseLock=()=>{releaseGate();if(tails.get(name)===tail)tails.delete(name);};
            return [[{acquired:1}],[]];
          }
          if(sql.startsWith('SELECT RELEASE_LOCK')){
            releaseLock?.();releaseLock=null;
            return [[{released:1}],[]];
          }
          throw new Error('Unexpected SQL: '+sql);
        },
        release(){releaseLock?.();releaseLock=null;}
      };
    }
  };
}

const ctx=id=>({from:{id}});

test('updates from the same active admin account are serialized',async()=>{
  const database=fakeLockDatabase();
  const lock=createAdminUpdateLock({database,lookupAdmin:async()=>({is_active:1}),isSuperAdmin:()=>false});
  let releaseFirst,signalFirst;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const firstStarted=new Promise(resolve=>{signalFirst=resolve;});
  const order=[];let active=0,maxActive=0;
  const first=lock(ctx(12345),async()=>{active++;maxActive=Math.max(maxActive,active);order.push('first:start');signalFirst();await firstGate;order.push('first:end');active--;});
  await firstStarted;
  const second=lock(ctx(12345),async()=>{active++;maxActive=Math.max(maxActive,active);order.push('second:start');order.push('second:end');active--;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,['first:start']);
  releaseFirst();
  await Promise.all([first,second]);
  assert.deepEqual(order,['first:start','first:end','second:start','second:end']);
  assert.equal(maxActive,1);
});

test('different admin accounts do not block each other',async()=>{
  const database=fakeLockDatabase();
  const lock=createAdminUpdateLock({database,lookupAdmin:async()=>({is_active:1}),isSuperAdmin:()=>false});
  let releaseFirst,signalSecond;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const secondStarted=new Promise(resolve=>{signalSecond=resolve;});
  const first=lock(ctx(11111),async()=>{await firstGate;});
  const second=lock(ctx(22222),async()=>{signalSecond();});
  await secondStarted;
  releaseFirst();
  await Promise.all([first,second]);
});

test('inactive and non-admin accounts bypass the database lock',async()=>{
  const database={async getConnection(){throw new Error('inactive account must not acquire a lock');}};
  const inactive=createAdminUpdateLock({database,lookupAdmin:async()=>({is_active:0}),isSuperAdmin:()=>false});
  const unknown=createAdminUpdateLock({database,lookupAdmin:async()=>null,isSuperAdmin:()=>false});
  let calls=0;
  await inactive(ctx(11111),async()=>{calls++;});
  await unknown(ctx(22222),async()=>{calls++;});
  assert.equal(calls,2);
});
