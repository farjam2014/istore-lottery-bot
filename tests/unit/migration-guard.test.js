import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMigrationAllowed} from '../../src/database/migration-guard.js';

test('migrations are denied by default',()=>{
  assert.throws(
    ()=>assertMigrationAllowed({database:'ustore_live',nodeEnv:'production',env:{}}),
    /disabled by default/
  );
});

test('test migrations require a disposable database name',()=>{
  assert.throws(
    ()=>assertMigrationAllowed({database:'ustore_live',nodeEnv:'test',env:{ALLOW_DATABASE_MIGRATIONS:'1'}}),
    /restricted to databases/
  );
});

test('CI migration is allowed only with explicit opt-in and disposable database',()=>{
  assert.doesNotThrow(
    ()=>assertMigrationAllowed({database:'istore_lottery_ci',nodeEnv:'test',env:{ALLOW_DATABASE_MIGRATIONS:'1'}})
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

test('development migrations also require explicit opt-in',()=>{
  assert.throws(
    ()=>assertMigrationAllowed({database:'ustore_dev',nodeEnv:'development',env:{}}),
    /disabled by default/
  );
  assert.doesNotThrow(
    ()=>assertMigrationAllowed({database:'ustore_dev',nodeEnv:'development',env:{ALLOW_DATABASE_MIGRATIONS:'1'}})
  );
});
