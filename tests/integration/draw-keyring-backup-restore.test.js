import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import mysql from 'mysql2/promise';
import {pool} from '../../src/database/pool.js';
import {migrate} from '../../src/database/migrate.js';
import {loadDrawKeyring,encryptDrawSeed,decryptDrawSeed} from '../../src/modules/draw/draw-keyring.js';

const enabled=process.env.RUN_MYSQL_TESTS==='1';
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
  const restoreDatabase='draw_restore_'+randomBytes(8).toString('hex')+'_ci';
  assert.ok(restoreDatabase.length<=64);
  const childEnv={...process.env,MYSQL_PWD:String(process.env.MYSQL_PASSWORD||'')};
  const oldKeyring=loadDrawKeyring({
    DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'key-a':oldKey}),
    DRAW_SEED_ACTIVE_KEY_ID:'key-a'
  });
  const historicalSeed=randomBytes(32).toString('hex');
  const encrypted=encryptDrawSeed(historicalSeed,oldKeyring);
  let campaignId;
  let drawId;
  let restored;
  let restoreCreated=false;
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

    execFileSync('mysql',['--host',host,'--port',port,'--user',user,'--execute','CREATE DATABASE `'+restoreDatabase+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'],{env:childEnv,stdio:'pipe'});
    restoreCreated=true;
    const backup=execFileSync('mysqldump',[
      '--host',host,'--port',port,'--user',user,
      '--single-transaction','--skip-lock-tables','--no-tablespaces',
      '--column-statistics=0',database
    ],{env:childEnv,encoding:'buffer',maxBuffer:128*1024*1024});
    assert.ok(backup.length>0,'mysqldump returned an empty backup.');
    execFileSync('mysql',['--host',host,'--port',port,'--user',user,restoreDatabase],{
      env:childEnv,input:backup,stdio:['pipe','pipe','pipe'],maxBuffer:128*1024*1024
    });

    restored=await mysql.createConnection({host,port:Number(port),user,password:String(process.env.MYSQL_PASSWORD||''),database:restoreDatabase});
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
    if(restored){try{await restored.end();}catch(error){cleanupErrors.push(error);}}
    if(drawId){try{await pool.execute('DELETE FROM campaign_draws WHERE id=?',[drawId]);}catch(error){cleanupErrors.push(error);}}
    if(campaignId){try{await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}catch(error){cleanupErrors.push(error);}}
    if(restoreCreated){try{execFileSync('mysql',['--host',host,'--port',port,'--user',user,'--execute','DROP DATABASE IF EXISTS `'+restoreDatabase+'`'],{env:childEnv,stdio:'pipe'});}catch(error){cleanupErrors.push(error);}}
    if(cleanupErrors.length) throw new AggregateError(primaryError?[primaryError,...cleanupErrors]:cleanupErrors,'Backup/restore integration fixture cleanup failed.');
  }
});
