import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveMigrationCredentials,assertRuntimeCredentialsSeparated} from '../../src/database/migration-credentials.js';

const runtime={NODE_ENV:'production',MYSQL_USER:'ustore_app_abcdef123456',MYSQL_PASSWORD:'runtime-password'};

test('production migration requires a distinct protected migration account',()=>{
  assert.throws(()=>resolveMigrationCredentials(runtime),/require separate MYSQL_MIGRATION_USER/);
  assert.throws(()=>resolveMigrationCredentials({...runtime,MYSQL_MIGRATION_USER:runtime.MYSQL_USER,MYSQL_MIGRATION_PASSWORD:'migration-password'}),/must be different from the runtime MYSQL_USER/);
  assert.throws(()=>resolveMigrationCredentials({...runtime,MYSQL_MIGRATION_USER:'ustore_migrate_abcdef123456',MYSQL_MIGRATION_PASSWORD:runtime.MYSQL_PASSWORD}),/password must be different/);
});

test('production migration resolves only the separate migration credentials',()=>{
  const result=resolveMigrationCredentials({...runtime,MYSQL_MIGRATION_USER:'ustore_migrate_abcdef123456',MYSQL_MIGRATION_PASSWORD:'migration-password'});
  assert.deepEqual(result,{user:'ustore_migrate_abcdef123456',password:'migration-password',sharedRuntimePool:false});
});

test('non-production tests may reuse the isolated runtime test account when no migration account is supplied',()=>{
  const result=resolveMigrationCredentials({...runtime,NODE_ENV:'test'});
  assert.deepEqual(result,{user:runtime.MYSQL_USER,password:runtime.MYSQL_PASSWORD,sharedRuntimePool:true});
});

test('explicit non-production migration credentials must be complete and distinct',()=>{
  assert.throws(()=>resolveMigrationCredentials({...runtime,NODE_ENV:'test',MYSQL_MIGRATION_USER:'migration'}),/must be supplied together/);
  assert.throws(()=>resolveMigrationCredentials({...runtime,NODE_ENV:'test',MYSQL_MIGRATION_USER:runtime.MYSQL_USER,MYSQL_MIGRATION_PASSWORD:'migration'}),/must be different/);
});


test('production bot runtime refuses migration credentials even if they leak into .env',()=>{
  assert.throws(()=>assertRuntimeCredentialsSeparated({...runtime,MYSQL_MIGRATION_USER:'ustore_migrate_abcdef123456',MYSQL_MIGRATION_PASSWORD:'migration-password'}),/must not be present in the production bot runtime/);
  assert.doesNotThrow(()=>assertRuntimeCredentialsSeparated(runtime));
  assert.doesNotThrow(()=>assertRuntimeCredentialsSeparated({...runtime,NODE_ENV:'test',MYSQL_MIGRATION_USER:'test_migrate',MYSQL_MIGRATION_PASSWORD:'test-password'}));
});
