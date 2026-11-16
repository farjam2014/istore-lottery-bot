import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMigrationAllowed} from '../../src/database/migration-guard.js';

test('migrations are denied by default',()=>{
  assert.throws(
    ()=>assertMigrationAllowed({database:'ustore_live',nodeEnv:'production',env:{}}),
    /disabled by default/
  );
});

test('test migrations require a dedicated opt-in',()=>{
  assert.throws(
    ()=>assertMigrationAllowed({database:'istore_lottery_ci',nodeEnv:'test',host:'127.0.0.1',env:{ALLOW_DATABASE_MIGRATIONS:'1'}}),
    /ALLOW_TEST_DATABASE_MIGRATIONS/
  );
});

test('test migrations require a disposable database name',()=>{
  assert.throws(
    ()=>assertMigrationAllowed({database:'ustore_live',nodeEnv:'test',host:'127.0.0.1',env:{ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_TEST_DATABASE_MIGRATIONS:'1'}}),
    /restricted to databases/
  );
});

test('test migrations reject non-loopback database hosts',()=>{
  const env={ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_TEST_DATABASE_MIGRATIONS:'1'};
  assert.throws(
    ()=>assertMigrationAllowed({database:'istore_lottery_ci',nodeEnv:'test',host:'db.production.internal',env}),
    /loopback database hosts/
  );
  assert.throws(
    ()=>assertMigrationAllowed({database:'istore_lottery_ci',nodeEnv:'test',env}),
    /loopback database hosts/
  );
});

test('CI migration requires explicit test opt-in, disposable database, and loopback host',()=>{
  const env={ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_TEST_DATABASE_MIGRATIONS:'1'};
  assert.doesNotThrow(
    ()=>assertMigrationAllowed({database:'istore_lottery_ci',nodeEnv:'test',host:'127.0.0.1',env})
  );
  assert.doesNotThrow(
    ()=>assertMigrationAllowed({database:'ustore_local_test',nodeEnv:'test',host:'localhost',env})
  );
});

test('production migration requires two explicit flags and an exact database target',()=>{
  const base={database:'ustore_live',nodeEnv:'production'};
  assert.throws(
    ()=>assertMigrationAllowed({...base,env:{ALLOW_DATABASE_MIGRATIONS:'1'}}),
    /ALLOW_PRODUCTION_MIGRATIONS/
  );
  assert.throws(
    ()=>assertMigrationAllowed({...base,env:{ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_PRODUCTION_MIGRATIONS:'1',MIGRATION_TARGET_DATABASE:'another_db'}}),
    /target mismatch/
  );
  assert.doesNotThrow(
    ()=>assertMigrationAllowed({...base,env:{ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_PRODUCTION_MIGRATIONS:'1',MIGRATION_TARGET_DATABASE:'ustore_live'}})
  );
});

test('development migrations cannot bypass the non-test target guard',()=>{
  const base={database:'ustore_dev',nodeEnv:'development'};
  assert.throws(
    ()=>assertMigrationAllowed({...base,env:{ALLOW_DATABASE_MIGRATIONS:'1'}}),
    /ALLOW_PRODUCTION_MIGRATIONS/
  );
  assert.throws(
    ()=>assertMigrationAllowed({...base,env:{ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_PRODUCTION_MIGRATIONS:'1',MIGRATION_TARGET_DATABASE:'another_db'}}),
    /target mismatch/
  );
  assert.doesNotThrow(
    ()=>assertMigrationAllowed({...base,env:{ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_PRODUCTION_MIGRATIONS:'1',MIGRATION_TARGET_DATABASE:'ustore_dev'}})
  );
});

test('unknown environments are rejected',()=>{
  assert.throws(
    ()=>assertMigrationAllowed({database:'any_db',nodeEnv:'staging',env:{ALLOW_DATABASE_MIGRATIONS:'1',ALLOW_PRODUCTION_MIGRATIONS:'1',MIGRATION_TARGET_DATABASE:'any_db'}}),
    /Unsupported NODE_ENV/
  );
});
