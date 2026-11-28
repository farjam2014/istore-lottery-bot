import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseMigrationConnection} from '../../src/database/migration-lock.js';

function fakeConnection(releaseResult=1,throws=false){
  const state={released:0,destroyed:0,queries:0};
  return {state,
    async query(sql,params){
      state.queries++;
      assert.match(sql,/RELEASE_LOCK/);
      assert.deepEqual(params,['migration-lock']);
      if(throws)throw new Error('release timeout');
      return [[{released:releaseResult}],[]];
    },
    release(){state.released++;},
    destroy(){state.destroyed++;}
  };
}

test('migration connection returns to pool only after confirmed lock release',async()=>{
  const connection=fakeConnection(1);
  const reusable=await releaseMigrationConnection(connection,{lockAcquisitionResolved:true,lockAcquired:true,lockName:'migration-lock'});
  assert.equal(reusable,true);
  assert.equal(connection.state.released,1);
  assert.equal(connection.state.destroyed,0);
});

test('migration connection is destroyed when lock release result is uncertain',async()=>{
  const connection=fakeConnection(null);
  const reusable=await releaseMigrationConnection(connection,{lockAcquisitionResolved:true,lockAcquired:true,lockName:'migration-lock'});
  assert.equal(reusable,false);
  assert.equal(connection.state.released,0);
  assert.equal(connection.state.destroyed,1);
});

test('migration connection is destroyed when RELEASE_LOCK throws',async()=>{
  const connection=fakeConnection(1,true);
  const reusable=await releaseMigrationConnection(connection,{lockAcquisitionResolved:true,lockAcquired:true,lockName:'migration-lock'});
  assert.equal(reusable,false);
  assert.equal(connection.state.destroyed,1);
});

test('migration connection is destroyed when GET_LOCK outcome is unknown',async()=>{
  const connection=fakeConnection();
  const reusable=await releaseMigrationConnection(connection,{lockAcquisitionResolved:false,lockAcquired:false,lockName:'migration-lock'});
  assert.equal(reusable,false);
  assert.equal(connection.state.queries,0);
  assert.equal(connection.state.destroyed,1);
});

test('connection is reusable when GET_LOCK definitively reports not acquired',async()=>{
  const connection=fakeConnection();
  const reusable=await releaseMigrationConnection(connection,{lockAcquisitionResolved:true,lockAcquired:false,lockName:'migration-lock'});
  assert.equal(reusable,true);
  assert.equal(connection.state.released,1);
  assert.equal(connection.state.destroyed,0);
});
