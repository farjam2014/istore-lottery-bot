import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import mysql from 'mysql2/promise';

const enabled=process.env.RUN_MYSQL_TESTS==='1'&&Boolean(process.env.MYSQL_TEST_ADMIN_USER);
const splitSql=source=>source.split(/;\s*(?:\n|$)/).map(statement=>statement.trim()).filter(Boolean);
const quoteIdentifier=value=>String.fromCharCode(96)+String(value).replaceAll(String.fromCharCode(96),String.fromCharCode(96)+String.fromCharCode(96))+String.fromCharCode(96);
async function clearFixtureSchema(connection,database){
  const [objects]=await connection.execute('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[database]);
  await connection.query('SET FOREIGN_KEY_CHECKS=0');
  try{
    for(const object of objects)await connection.query('DROP '+(object.TABLE_TYPE==='VIEW'?'VIEW':'TABLE')+' IF EXISTS '+quoteIdentifier(object.TABLE_NAME));
  }finally{await connection.query('SET FOREIGN_KEY_CHECKS=1');}
}

test('read-only production preflight executes against the legacy base schema with all release migrations pending',{skip:!enabled},async()=>{
  const host=process.env.MYSQL_HOST||'127.0.0.1';
  const port=Number(process.env.MYSQL_PORT||3306);
  const adminUser=process.env.MYSQL_TEST_ADMIN_USER;
  const adminPassword=process.env.MYSQL_TEST_ADMIN_PASSWORD||'';
  const readOnlyUser=process.env.MYSQL_TEST_READONLY_USER;
  const readOnlyPassword=process.env.MYSQL_TEST_READONLY_PASSWORD||'';
  const databaseName=process.env.MYSQL_PREFLIGHT_DATABASE||'';
  assert.ok(adminUser&&readOnlyUser&&readOnlyPassword,'Dedicated fixture-admin and read-only accounts are required.');
  assert.match(databaseName,/^ustore_preflight_[A-Za-z0-9_]+_ci$/,'A pre-provisioned preflight fixture schema is required.');
  assert.notEqual(databaseName,process.env.MYSQL_DATABASE,'Preflight schema must differ from the application test schema.');
  const admin=await mysql.createConnection({host,port,user:adminUser,password:adminPassword});
  let baseConnection=null,readOnlyConnection=null;
  try{
    const [[existing]]=await admin.execute('SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[databaseName]);
    assert.equal(Number(existing.total),0,'Preflight fixture schema must be empty before the test.');
    baseConnection=await mysql.createConnection({host,port,user:adminUser,password:adminPassword,database:databaseName});
    const baseSchema=readFileSync(new URL('../../src/database/schema.sql',import.meta.url),'utf8');
    for(const statement of splitSql(baseSchema))await baseConnection.query(statement);
    await baseConnection.query(`CREATE TABLE schema_migrations (
      version VARCHAR(120) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    readOnlyConnection=await mysql.createConnection({host,port,user:readOnlyUser,password:readOnlyPassword,database:databaseName});
    await assert.rejects(
      readOnlyConnection.query("INSERT INTO campaigns(slug,title,status,participation_type) VALUES('preflight-write-denied','Preflight write denied','draft','free')"),
      error=>error.code==='ER_TABLEACCESS_DENIED_ERROR'
    );
    const preflight=readFileSync(new URL('../../scripts/production-migration-preflight.sql',import.meta.url),'utf8');
    const resultSets=[];
    for(const statement of splitSql(preflight)){
      const [result]=await readOnlyConnection.query(statement);
      if(Array.isArray(result))resultSets.push(...result);
    }
    const pendingDrawChecks=resultSets.filter(row=>row?.check_status==='PENDING_MIGRATION_003');
    assert.equal(pendingDrawChecks.length,2,'Both draw relational checks must report pending instead of querying migration-only columns.');
    const historyRows=resultSets.filter(row=>row?.migration_status==='MISSING');
    assert.equal(historyRows.length,28,'Preflight must report all 28 release migrations as pending on a legacy baseline.');
  }finally{
    if(readOnlyConnection)await readOnlyConnection.end();
    if(baseConnection)await baseConnection.end();
    await clearFixtureSchema(admin,databaseName).catch(()=>{});
    await admin.end();
  }
});

test('post-migration integrity SQL executes after all versioned migrations are applied',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  try{
    await migrate();
    const [[history]]=await pool.execute('SELECT COUNT(*) AS total FROM schema_migrations');
    assert.ok(Number(history.total)>=28,'Expected all release migrations to be recorded before post-migration checks.');
    const integrity=readFileSync(new URL('../../scripts/post-migration-integrity-check.sql',import.meta.url),'utf8');
    const statements=splitSql(integrity);
    assert.equal(statements.length,4);
    for(const statement of statements){
      const executable=statement.replace(/^\s*--.*$/gm,'').trim();
      assert.match(executable,/^SELECT\b/i,'Post-migration integrity statements must remain SELECT-only.');
      const [rows]=await pool.execute(statement);
      assert.ok(Array.isArray(rows));
    }
  }finally{
    const {closeMigrationPool}=await import('../../src/database/migration-pool.js');
    await closeMigrationPool();
    await pool.end();
  }
});
