import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: processed Telegram updates can be reclaimed after lease expiry but not concurrently', {skip:!enabled}, async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Processed-update lease integration must use an isolated database');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {claimProcessedUpdate,completeProcessedUpdate,releaseProcessedUpdate}=await import('../../src/modules/telegram/processed-update.service.js');
  const updateId=Number(BigInt(Date.now())*1000n+BigInt(Math.floor(Math.random()*900)+100));
  const secondUpdateId=updateId+1;
  const correlationId='lease-test-'+updateId;
  let firstToken,secondToken,concurrentToken;
  try{
    await migrate();
    const first=await claimProcessedUpdate({updateId,correlationId});
    assert.equal(first.claimed,true);
    assert.equal(first.isNew,true);
    firstToken=first.leaseToken;

    const duplicate=await claimProcessedUpdate({updateId,correlationId:'different-correlation'});
    assert.equal(duplicate.claimed,false);
    assert.equal(duplicate.reason,'processing');

    await pool.execute('UPDATE processed_updates SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE update_id=? AND lease_token=?',[updateId,firstToken]);
    const reclaimed=await claimProcessedUpdate({updateId,correlationId:'retry-correlation'});
    assert.equal(reclaimed.claimed,true);
    assert.equal(reclaimed.isNew,false);
    assert.equal(reclaimed.correlationId,correlationId,'A reclaimed update retains its original correlation ID');
    secondToken=reclaimed.leaseToken;
    assert.notEqual(secondToken,firstToken);
    assert.equal(await completeProcessedUpdate({updateId,leaseToken:firstToken}),false,'The old worker cannot complete a reclaimed lease');

    const [[row]]=await pool.execute('SELECT status,attempts,correlation_id,lease_token FROM processed_updates WHERE update_id=?',[updateId]);
    assert.equal(row.status,'processing');
    assert.equal(Number(row.attempts),2);
    assert.equal(row.lease_token,secondToken);

    assert.equal(await completeProcessedUpdate({updateId,leaseToken:secondToken}),true);
    const completedDuplicate=await claimProcessedUpdate({updateId,correlationId});
    assert.equal(completedDuplicate.claimed,false);
    assert.equal(completedDuplicate.reason,'completed');

    const second=await claimProcessedUpdate({updateId:secondUpdateId,correlationId:correlationId+'-concurrent'});
    assert.equal(second.claimed,true);
    await pool.execute('UPDATE processed_updates SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE update_id=? AND lease_token=?',[secondUpdateId,second.leaseToken]);
    const contenders=await Promise.all([
      claimProcessedUpdate({updateId:secondUpdateId,correlationId}),
      claimProcessedUpdate({updateId:secondUpdateId,correlationId})
    ]);
    assert.equal(contenders.filter(x=>x.claimed).length,1,'Only one concurrent process may reclaim an expired lease');
    assert.equal(contenders.filter(x=>!x.claimed).length,1);
    concurrentToken=contenders.find(x=>x.claimed).leaseToken;
    assert.equal(await completeProcessedUpdate({updateId:secondUpdateId,leaseToken:concurrentToken}),true);

    const releasable=await claimProcessedUpdate({updateId:updateId+2,correlationId:correlationId+'-release'});
    assert.equal(releasable.claimed,true);
    assert.equal(await releaseProcessedUpdate({updateId:updateId+2,leaseToken:releasable.leaseToken}),true);
    const afterRelease=await claimProcessedUpdate({updateId:updateId+2,correlationId:correlationId+'-release-retry'});
    assert.equal(afterRelease.claimed,true);
    assert.equal(afterRelease.isNew,true,'A released failed claim may be retried as a new claim');
    await completeProcessedUpdate({updateId:updateId+2,leaseToken:afterRelease.leaseToken});
  }finally{
    await pool.execute('DELETE FROM processed_updates WHERE update_id IN (?,?,?)',[updateId,secondUpdateId,updateId+2]);
  }
});

test.after(async()=>{
  if(enabled){
    const {pool}=await import('../../src/database/pool.js');
    await pool.end();
  }
});
