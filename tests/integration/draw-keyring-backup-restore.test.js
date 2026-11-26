import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import mysql from 'mysql2/promise';
import {pool} from '../../src/database/pool.js';
import {migrate} from '../../src/database/migrate.js';
import {getMigrationPool,closeMigrationPool} from '../../src/database/migration-pool.js';
import {loadDrawKeyring,encryptDrawSeed,decryptDrawSeed} from '../../src/modules/draw/draw-keyring.js';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

after(async()=>{await closeMigrationPool();await pool.end();});
const oldKey='31'.repeat(32);
const newKey='42'.repeat(32);
const sha256=value=>createHash('sha256').update(value).digest('hex');

async function migrateWithDeadlockRetry(maxAttempts=6){
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{return await migrate();}
    catch(error){
      if(error?.code!=='ER_LOCK_DEADLOCK'||attempt===maxAttempts)throw error;
      // MySQL may report a transient DDL/metadata-lock deadlock while other
      // integration workers are using the disposable schema. Back off before
      // reacquiring the migration advisory lock and replaying idempotent guards.
      await new Promise(resolve=>setTimeout(resolve,250*(2**(attempt-1))));
    }
  }
}

test('MySQL backup/restore preserves prepared draw ciphertext and historical key recovery after rotation',{skip:!enabled},async()=>{
  const database=String(process.env.MYSQL_DATABASE||'');
  const host=String(process.env.MYSQL_HOST||'');
  assert.match(database,/_ci$|_test$/,'Backup/restore test is restricted to disposable _ci or _test databases.');
  assert.ok(['127.0.0.1','localhost','::1'].includes(host),'Backup/restore test is restricted to loopback MySQL.');
  const port=String(process.env.MYSQL_PORT||'3306');
  const user=String(process.env.MYSQL_USER||'');
  assert.ok(user,'MYSQL_USER is required.');
  const backupUser=String(process.env.MYSQL_BACKUP_USER||'');
  const backupPassword=String(process.env.MYSQL_BACKUP_PASSWORD||'');
  const restoreUser=String(process.env.MYSQL_RESTORE_USER||'');
  const restorePassword=String(process.env.MYSQL_RESTORE_PASSWORD||'');
  const restoreRuntimeUser=String(process.env.MYSQL_RESTORE_RUNTIME_USER||'');
  const restoreRuntimePassword=String(process.env.MYSQL_RESTORE_RUNTIME_PASSWORD||'');
  assert.ok(backupUser&&backupPassword,'A dedicated schema-scoped backup identity with SELECT, SHOW VIEW and TRIGGER is required.');
  assert.ok(restoreUser&&restorePassword,'A dedicated schema-scoped restore identity is required.');
  assert.ok(restoreRuntimeUser&&restoreRuntimePassword,'A separate DML-only restored-runtime identity is required.');
  assert.notEqual(user,backupUser,'Application and backup identities must be distinct.');
  assert.notEqual(user,restoreUser,'Application and restore identities must be distinct.');
  assert.notEqual(backupUser,restoreUser,'Backup and restore identities must be distinct.');
  assert.notEqual(restoreRuntimeUser,user,'Restored runtime and source application identities must be distinct.');
  assert.notEqual(restoreRuntimeUser,restoreUser,'Restored runtime and temporary restore identities must be distinct.');
  assert.notEqual(restoreRuntimeUser,backupUser,'Restored runtime and backup identities must be distinct.');
  const restoreDatabase=String(process.env.MYSQL_RESTORE_DATABASE||'');
  const adminUser=String(process.env.MYSQL_TEST_ADMIN_USER||'');
  const adminPassword=String(process.env.MYSQL_TEST_ADMIN_PASSWORD||'');
  assert.ok(adminUser&&adminPassword,'A test-only grant inspection identity is required.');
  const grantInspector=await mysql.createConnection({host,port:Number(port),user:adminUser,password:adminPassword,database:'mysql'});
  let migrationHost;
  try{
    const accountHost=async(account,schemaName)=>{
      const [rows]=await grantInspector.execute("SELECT DISTINCT SUBSTRING(SUBSTRING_INDEX(GRANTEE,'@',-1),2,CHAR_LENGTH(SUBSTRING_INDEX(GRANTEE,'@',-1))-2) AS Host FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE LIKE CONCAT(QUOTE(?),'@%') AND TABLE_SCHEMA=?",[account,schemaName]);
      assert.equal(rows.length,1,'Each disposable integration identity must have grants at exactly one MySQL host.');
      return String(rows[0].Host);
    };
    const backupHost=await accountHost(backupUser,database);
    const restoreHost=await accountHost(restoreUser,restoreDatabase);
    migrationHost=await accountHost(String(process.env.MYSQL_MIGRATION_USER||''),database);
    const restoreRuntimeHost=await accountHost(restoreRuntimeUser,restoreDatabase);
    const [[schema]]=await grantInspector.execute("SELECT GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE SEPARATOR ',') AS privileges FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND TABLE_SCHEMA=?",[backupUser,backupHost,database]);
    const [[global]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND PRIVILEGE_TYPE<>'USAGE'",[backupUser,backupHost]);
    const [[otherSchemas]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND TABLE_SCHEMA<>?",[backupUser,backupHost,database]);
    const [[tableGrants]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?))",[backupUser,backupHost]);
    const [[columnGrants]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?))",[backupUser,backupHost]);
    const [[routineGrants]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM mysql.procs_priv WHERE User=? AND Host=?",[backupUser,backupHost]);
    const [[roles]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM mysql.role_edges WHERE TO_USER=? AND TO_HOST=?",[backupUser,backupHost]);
    const [[proxy]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM mysql.proxies_priv WHERE User=? AND Host=?",[backupUser,backupHost]);
    const [[restoreGlobal]]=await grantInspector.execute("SELECT GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE SEPARATOR ',') AS privileges FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND PRIVILEGE_TYPE<>'USAGE'",[restoreUser,restoreHost]);
    const [[migrationSourceSchema]]=await grantInspector.execute("SELECT GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE SEPARATOR ',') AS privileges FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND TABLE_SCHEMA=?",[process.env.MYSQL_MIGRATION_USER,migrationHost,database]);
    const [[migrationRestoreSchema]]=await grantInspector.execute("SELECT GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE SEPARATOR ',') AS privileges FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND TABLE_SCHEMA=?",[process.env.MYSQL_MIGRATION_USER,migrationHost,restoreDatabase]);
    const [[restoreRuntimeSchema]]=await grantInspector.execute("SELECT GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE SEPARATOR ',') AS privileges FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND TABLE_SCHEMA=?",[restoreRuntimeUser,restoreRuntimeHost,restoreDatabase]);
    const [[restoreRuntimeGlobal]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND PRIVILEGE_TYPE<>'USAGE'",[restoreRuntimeUser,restoreRuntimeHost]);
    const [[restoreRuntimeOtherSchemas]]=await grantInspector.execute("SELECT COUNT(*) AS total FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(QUOTE(?),'@',QUOTE(?)) AND TABLE_SCHEMA<>?",[restoreRuntimeUser,restoreRuntimeHost,restoreDatabase]);
    assert.equal(schema.privileges,'SELECT,SHOW VIEW,TRIGGER','backup account must have only the schema-scoped dump privileges');
    assert.equal(Number(global.total),0);
    assert.equal(Number(otherSchemas.total),0);
    assert.equal(Number(tableGrants.total),0);
    assert.equal(Number(columnGrants.total),0);
    assert.equal(Number(routineGrants.total),0);
    assert.equal(Number(roles.total),0);
    assert.equal(Number(proxy.total),0);
    assert.equal(restoreGlobal.privileges,'SET_USER_ID','restore-only identity may hold only SET_USER_ID globally, never SUPER or unrelated global privileges');
    assert.equal(migrationSourceSchema.privileges,'ALTER,CREATE,DELETE,INDEX,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE','migration identity must retain only the explicitly provisioned source-schema migration privileges.');
    assert.equal(migrationRestoreSchema.privileges,'TRIGGER','migration identity may act as DEFINER on the isolated restore schema only through TRIGGER privilege.');
    assert.equal(restoreRuntimeSchema.privileges,'DELETE,INSERT,SELECT,UPDATE','restored runtime identity must have only schema-scoped DML.');
    assert.equal(Number(restoreRuntimeGlobal.total),0,'restored runtime identity must have no global privileges.');
    assert.equal(Number(restoreRuntimeOtherSchemas.total),0,'restored runtime identity must have no grants on other schemas.');
  }finally{await grantInspector.end();}
  const backupEnv={...process.env,MYSQL_PWD:backupPassword};
  const restoreEnv={...process.env,MYSQL_PWD:restorePassword};
  assert.match(restoreDatabase,/^draw_restore_[A-Za-z0-9_]+_ci$/,'A pre-provisioned isolated restore database is required.');
  assert.notEqual(restoreDatabase,database,'Restore database must differ from source database.');
  assert.notEqual(restoreDatabase,process.env.MYSQL_PREFLIGHT_DATABASE);
  assert.notEqual(restoreDatabase,process.env.MYSQL_DRAW_GUARD_DATABASE);
  assert.ok(restoreDatabase.length<=64);
  const oldKeyring=loadDrawKeyring({
    DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'key-a':oldKey}),
    DRAW_SEED_ACTIVE_KEY_ID:'key-a'
  });
  const historicalSeed=randomBytes(32).toString('hex');
  const encrypted=encryptDrawSeed(historicalSeed,oldKeyring);
  let campaignId;
  let drawId;
  let restored;
  let restoredRuntime;
  let primaryError;
  try{
    await migrateWithDeadlockRetry();
    const [campaign]=await pool.execute(
      "INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'closed','free',1)",
      ['backup-restore-'+randomBytes(8).toString('hex'),'Backup restore keyring test']
    );
    campaignId=campaign.insertId;
    const [draw]=await pool.execute(
      "INSERT INTO campaign_draws(campaign_id,status,algorithm,seed_hash,candidate_count,winner_count,created_by,seed_ciphertext,seed_nonce,seed_tag,seed_key_id,candidate_snapshot_hash) VALUES(?,'prepared','HMAC-SHA256 candidate-commitment-rank-v2',?,1,1,?,?,?,?,?,?)",
      [campaignId,sha256(historicalSeed),'900000001',encrypted.ciphertext,encrypted.nonce,encrypted.tag,encrypted.keyId,'a'.repeat(64)]
    );
    drawId=draw.insertId;

    const backupProbe=await mysql.createConnection({host,port:Number(port),user:backupUser,password:backupPassword,database});
    try{
      await assert.rejects(backupProbe.execute('CREATE TABLE backup_write_probe(id INT PRIMARY KEY)'),error=>error.code==='ER_TABLEACCESS_DENIED_ERROR');
      await assert.rejects(backupProbe.execute("INSERT INTO campaigns(slug,title,status,participation_type) VALUES('backup-write-probe','x','closed','free')"),error=>error.code==='ER_TABLEACCESS_DENIED_ERROR');
      await assert.rejects(backupProbe.execute('UPDATE campaigns SET title=title WHERE id=?',[campaignId]),error=>error.code==='ER_TABLEACCESS_DENIED_ERROR');
      await assert.rejects(backupProbe.execute('DELETE FROM campaigns WHERE id=?',[campaignId]),error=>error.code==='ER_TABLEACCESS_DENIED_ERROR');
    }finally{await backupProbe.end();}
    assert.match(database,/^[A-Za-z0-9_]{1,64}$/,'Source database identifier must be safe to quote.');
    const restoreSourceProbe=await mysql.createConnection({host,port:Number(port),user:restoreUser,password:restorePassword,database:'information_schema'});
    try{
      const sourceSchema='`'+database+'`';
      await assert.rejects(restoreSourceProbe.execute('CREATE TABLE '+sourceSchema+'.restore_scope_probe(id INT PRIMARY KEY)'),error=>['ER_DBACCESS_DENIED_ERROR','ER_TABLEACCESS_DENIED_ERROR'].includes(error.code));
      await assert.rejects(restoreSourceProbe.execute('SELECT id FROM '+sourceSchema+'.campaigns LIMIT 1'),error=>['ER_DBACCESS_DENIED_ERROR','ER_TABLEACCESS_DENIED_ERROR'].includes(error.code));
    }finally{await restoreSourceProbe.end();}
    const [[emptyTables]]=await mysql.createConnection({host,port:Number(port),user:restoreUser,password:restorePassword,database:'information_schema'}).then(async conn=>{
      try{return await conn.execute('SELECT COUNT(*) AS total FROM TABLES WHERE TABLE_SCHEMA=?',[restoreDatabase]);}
      finally{await conn.end();}
    });
    assert.equal(Number(emptyTables.total),0,'Pre-provisioned restore schema must be empty before import.');
    const [sourceTriggerRows]=await getMigrationPool().execute(
      "SELECT TRIGGER_NAME,DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('trg_admin_audit_log_no_update','trg_admin_audit_log_no_delete') ORDER BY TRIGGER_NAME"
    );
    assert.equal(sourceTriggerRows.length,2,'Source schema must contain both append-only audit triggers.');
    const sourceTriggerDefiners=sourceTriggerRows.map(row=>({name:row.TRIGGER_NAME,definer:row.DEFINER}));
    const expectedMigrationDefiner=String(process.env.MYSQL_MIGRATION_USER||'')+'@'+migrationHost;
    assert.ok(expectedMigrationDefiner!=='@%'&&sourceTriggerDefiners.every(row=>row.definer===expectedMigrationDefiner),'Audit triggers must be owned by the dedicated migration identity, not the runtime or restore identity.');
    const backup=execFileSync('mysqldump',[
      '--host',host,'--port',port,'--user',backupUser,
      '--single-transaction','--skip-lock-tables','--no-tablespaces',
      '--column-statistics=0',database
    ],{env:backupEnv,encoding:'buffer',maxBuffer:128*1024*1024,timeout:180000});
    assert.ok(backup.length>0,'mysqldump returned an empty backup.');
    const backupSql=backup.toString('utf8');
    assert.match(backupSql,/trg_admin_audit_log_no_update/i,'Backup must retain the append-only audit update trigger.');
    assert.match(backupSql,/trg_admin_audit_log_no_delete/i,'Backup must retain the append-only audit delete trigger.');
    execFileSync('mysql',['--host',host,'--port',port,'--user',restoreUser,restoreDatabase],{
      env:restoreEnv,input:backup,stdio:['pipe','pipe','pipe'],maxBuffer:128*1024*1024,timeout:180000
    });

    restored=await mysql.createConnection({host,port:Number(port),user:restoreUser,password:restorePassword,database:restoreDatabase});
    const [restoredTriggerRows]=await restored.execute(
      "SELECT TRIGGER_NAME,DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND TRIGGER_NAME IN ('trg_admin_audit_log_no_update','trg_admin_audit_log_no_delete') ORDER BY TRIGGER_NAME",
      [restoreDatabase]
    );
    assert.equal(restoredTriggerRows.length,2,'Append-only audit triggers must survive backup/restore.');
    assert.deepEqual(
      restoredTriggerRows.map(row=>({name:row.TRIGGER_NAME,definer:row.DEFINER})),
      sourceTriggerDefiners,
      'Restored audit triggers must preserve their original DEFINER identities.'
    );
    restoredRuntime=await mysql.createConnection({host,port:Number(port),user:restoreRuntimeUser,password:restoreRuntimePassword,database:restoreDatabase});
    const [auditInsert]=await restoredRuntime.execute("INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,'backup_restore_test',NULL,JSON_OBJECT('fixture',1))",[900000001,'restore_fixture']);
    await assert.rejects(restoredRuntime.execute('UPDATE admin_audit_log SET action=? WHERE id=?',['tampered',auditInsert.insertId]),error=>error.code==='ER_SIGNAL_EXCEPTION'&&/append-only/.test(error.message));
    await assert.rejects(restoredRuntime.execute('DELETE FROM admin_audit_log WHERE id=?',[auditInsert.insertId]),error=>error.code==='ER_SIGNAL_EXCEPTION'&&/append-only/.test(error.message));
    const [[restoredDraw]]=await restored.execute('SELECT id,campaign_id,status,seed_hash,seed_ciphertext,seed_nonce,seed_tag,seed_key_id FROM campaign_draws WHERE id=?',[drawId]);
    assert.ok(restoredDraw,'Prepared draw row was not present after database restore.');
    assert.equal(restoredDraw.status,'prepared');
    assert.equal(restoredDraw.seed_key_id,'key-a');

    // Model separately backed-up keyring restoration, then rotate while retaining key-a.
    const rotatedKeyring=loadDrawKeyring({
      DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'key-a':oldKey,'key-b':newKey}),
      DRAW_SEED_ACTIVE_KEY_ID:'key-b'
    });
    assert.equal(decryptDrawSeed(restoredDraw,rotatedKeyring),historicalSeed);
    assert.equal(sha256(decryptDrawSeed(restoredDraw,rotatedKeyring)),restoredDraw.seed_hash);

    const newSeed=randomBytes(32).toString('hex');
    const newlyEncrypted=encryptDrawSeed(newSeed,rotatedKeyring);
    assert.equal(newlyEncrypted.keyId,'key-b');
    assert.equal(decryptDrawSeed({
      seed_key_id:newlyEncrypted.keyId,
      seed_ciphertext:newlyEncrypted.ciphertext,
      seed_nonce:newlyEncrypted.nonce,
      seed_tag:newlyEncrypted.tag
    },rotatedKeyring),newSeed);

    const keyWithoutHistorical=loadDrawKeyring({
      DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'key-b':newKey}),
      DRAW_SEED_ACTIVE_KEY_ID:'key-b'
    });
    assert.throws(()=>decryptDrawSeed(restoredDraw,keyWithoutHistorical),/not available/);
  }catch(error){
    primaryError=error;
    throw error;
  }finally{
    const cleanupErrors=[];
    if(drawId){try{await pool.execute('DELETE FROM campaign_draws WHERE id=?',[drawId]);}catch(error){cleanupErrors.push(error);}}
    if(campaignId){try{await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}catch(error){cleanupErrors.push(error);}}
    if(restoredRuntime){try{await restoredRuntime.end();}catch(error){cleanupErrors.push(error);}}
    if(restored){
      try{
        await restored.query('SET FOREIGN_KEY_CHECKS=0');
        const [tables]=await restored.query('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[restoreDatabase]);
        for(const table of tables){
          const identifier=String.fromCharCode(96)+String(table.TABLE_NAME).replaceAll(String.fromCharCode(96),String.fromCharCode(96)+String.fromCharCode(96))+String.fromCharCode(96);
          await restored.query('DROP '+(table.TABLE_TYPE==='VIEW'?'VIEW':'TABLE')+' IF EXISTS '+identifier);
        }
        await restored.query('SET FOREIGN_KEY_CHECKS=1');
      }catch(error){cleanupErrors.push(error);}
      try{await restored.end();}catch(error){cleanupErrors.push(error);}
    }
    if(cleanupErrors.length) throw new AggregateError(primaryError?[primaryError,...cleanupErrors]:cleanupErrors,'Backup/restore integration fixture cleanup failed.');
  }
});
