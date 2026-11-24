import test from 'node:test';
import assert from 'node:assert/strict';
import {setAdminActive} from '../../src/modules/admin/admin-access.service.js';

function fakeDatabase(target,activeSuperAdmins=[target]){
  const state={target:{...target},events:[],updates:[],commits:0,rollbacks:0};
  const connection={
    async beginTransaction(){},
    async commit(){state.commits++;},
    async rollback(){state.rollbacks++;},
    release(){},
    async execute(sql,params=[]){
      if(sql.startsWith('SELECT role,is_active FROM admin_users'))return [[state.target?{role:state.target.role,is_active:state.target.is_active}:undefined].filter(Boolean),[]];
      if(sql.startsWith("SELECT telegram_user_id FROM admin_users WHERE role='super_admin'"))return [activeSuperAdmins.map(x=>({telegram_user_id:x.telegram_user_id})),[]];
      if(sql.startsWith('UPDATE admin_users SET is_active=')){state.target.is_active=params[0];state.updates.push(params);return [{affectedRows:1},[]];}
      if(sql.startsWith('INSERT INTO admin_role_events')){state.events.push(params);return [{insertId:1},[]];}
      throw new Error('Unexpected SQL: '+sql);
    }
  };
  return {state,async getConnection(){return connection;}};
}

test('admin activation is idempotent when desired state is already present',async()=>{
  const db=fakeDatabase({telegram_user_id:'12345',role:'support_agent',is_active:0});
  const result=await setAdminActive({targetId:'12345',actorId:'99999',expectedActive:0,isActive:0,database:db});
  assert.equal(result.changed,false);
  assert.equal(db.state.updates.length,0);
  assert.equal(db.state.events.length,0);
  assert.equal(db.state.commits,1);
});

test('stale admin activation action is rejected without changing state',async()=>{
  const db=fakeDatabase({telegram_user_id:'12345',role:'support_agent',is_active:1});
  await assert.rejects(setAdminActive({targetId:'12345',actorId:'99999',expectedActive:0,isActive:1,database:db}),/از زمان نمایش این دکمه تغییر کرده/);
  assert.equal(db.state.target.is_active,1);
  assert.equal(db.state.updates.length,0);
  assert.equal(db.state.rollbacks,1);
});

test('last active super admin cannot be deactivated',async()=>{
  const admin={telegram_user_id:'12345',role:'super_admin',is_active:1};
  const db=fakeDatabase(admin,[admin]);
  await assert.rejects(setAdminActive({targetId:'12345',actorId:'99999',expectedActive:1,isActive:0,database:db}),/آخرین مدیر کل فعال/);
  assert.equal(db.state.target.is_active,1);
  assert.equal(db.state.events.length,0);
  assert.equal(db.state.rollbacks,1);
});

test('admin deactivation writes state and audit event in one transaction',async()=>{
  const db=fakeDatabase({telegram_user_id:'12345',role:'support_agent',is_active:1});
  const result=await setAdminActive({targetId:'12345',actorId:'99999',expectedActive:1,isActive:0,database:db});
  assert.equal(result.changed,true);
  assert.equal(db.state.target.is_active,0);
  assert.equal(db.state.events.length,1);
  assert.equal(db.state.commits,1);
});
