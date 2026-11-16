import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseMigrationConnection} from '../../src/database/migration-connection.js';

const LOCK='ustore_telegram_bot_schema_migrations';

function connection({releaseResult=1,releaseError=null}={}){
  const calls={queries:[],released:0,destroyed:0};
  return {
    calls,
    async query(sql,values){
      calls.queries.push({sql,values});
      if(releaseError)throw releaseError;
      return [[{released:releaseResult}],[]];
    },
    release(){calls.released++;},
    destroy(){calls.destroyed++;}
  };
}

test('releases a connection only after confirmed advisory-lock release',async()=>{
  const c=connection();
  await releaseMigrationConnection(c,{lockName:LOCK,lockAcquisitionResolved:true,lockAcquired:true});
  assert.equal(c.calls.queries.length,1);
  assert.match(c.calls.queries[0].sql,/RELEASE_LOCK/);
  assert.deepEqual(c.calls.queries[0].values,[LOCK]);
  assert.equal(c.calls.released,1);
  assert.equal(c.calls.destroyed,0);
});

test('destroys a connection when RELEASE_LOCK returns zero or NULL',async()=>{
  for(const releaseResult of [0,null]){
    const c=connection({releaseResult});
    await releaseMigrationConnection(c,{lockName:LOCK,lockAcquisitionResolved:true,lockAcquired:true});
    assert.equal(c.calls.released,0);
    assert.equal(c.calls.destroyed,1);
  }
});

test('destroys a connection when RELEASE_LOCK throws',async()=>{
  const c=connection({releaseError:new Error('connection lost during release')});
  await releaseMigrationConnection(c,{lockName:LOCK,lockAcquisitionResolved:true,lockAcquired:true});
  assert.equal(c.calls.released,0);
  assert.equal(c.calls.destroyed,1);
});

test('destroys a connection when GET_LOCK outcome is unknown',async()=>{
  const c=connection();
  await releaseMigrationConnection(c,{lockName:LOCK,lockAcquisitionResolved:false,lockAcquired:false});
  assert.equal(c.calls.queries.length,0,'Do not attempt to release a lock whose acquisition result was never received');
  assert.equal(c.calls.released,0);
  assert.equal(c.calls.destroyed,1);
});

test('returns a connection to the pool when GET_LOCK definitively returned not acquired',async()=>{
  const c=connection();
  await releaseMigrationConnection(c,{lockName:LOCK,lockAcquisitionResolved:true,lockAcquired:false});
  assert.equal(c.calls.queries.length,0);
  assert.equal(c.calls.released,1);
  assert.equal(c.calls.destroyed,0);
});
