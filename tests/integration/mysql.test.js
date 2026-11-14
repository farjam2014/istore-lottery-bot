import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';
test('MySQL integration: clean schema, unique profile, multiple campaigns, frozen snapshot and idempotent codes',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Integration tests only run against a database ending in _ci or _test');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createProfile,findByTelegramId}=await import('../../src/modules/participants/participant.repository.js');
  const {joinFreeCampaign}=await import('../../src/modules/entries/entry.service.js');
  let participantId;const campaignIds=[];let telegramId;
  try{
    await migrate();
    telegramId=String(700000000000n+BigInt(Date.now()%100000000000n));
    await createProfile({telegramUserId:telegramId,username:'integration',fullName:'Integration Tester',phone:'+989121234567',instagramHandle:'integration_test'});
    const profile=await findByTelegramId(telegramId);participantId=profile.id;
    assert.equal(String(profile.telegram_user_id),telegramId);
    await assert.rejects(
      pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Duplicate Tester','+989121234567','duplicate_user']),
      e=>e.code==='ER_DUP_ENTRY'
    );
    for(let i=0;i<2;i++){
      const [c]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'open','free',2)",[`it-${telegramId}-${i}`,`Integration campaign ${i}`]);
      campaignIds.push(c.insertId);
    }
    const first=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[0]});
    assert.equal(first.codes.length,2);assert.equal(first.alreadyJoined,false);
    const repeated=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[0]});
    assert.equal(repeated.alreadyJoined,true);assert.deepEqual(repeated.codes,first.codes);
    const second=await joinFreeCampaign({telegramUserId:telegramId,campaignId:campaignIds[1]});
    assert.equal(second.codes.length,2);assert.notDeepEqual(second.codes,first.codes);
    await pool.execute("UPDATE participants SET full_name='Changed Name' WHERE id=?",[participantId]);
    const [[entry]]=await pool.execute('SELECT profile_snapshot FROM campaign_entries WHERE campaign_id=? AND participant_id=?',[campaignIds[0],participantId]);
    const snapshot=typeof entry.profile_snapshot==='string'?JSON.parse(entry.profile_snapshot):entry.profile_snapshot;
    assert.equal(snapshot.full_name,'Integration Tester');
    const [[count]]=await pool.execute('SELECT COUNT(*) AS total FROM campaign_codes WHERE campaign_id=?',[campaignIds[0]]);
    assert.equal(Number(count.total),2);
  }finally{
    if(participantId){
      const [entries]=await pool.execute('SELECT id FROM campaign_entries WHERE participant_id=?',[participantId]);
      for(const e of entries)await pool.execute('DELETE FROM campaign_codes WHERE campaign_entry_id=?',[e.id]);
      await pool.execute('DELETE FROM campaign_entries WHERE participant_id=?',[participantId]);
      await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
    }
    if(campaignIds.length)await pool.execute(`DELETE FROM campaigns WHERE id IN (${campaignIds.map(()=>'?').join(',')})`,campaignIds);
    await pool.end();
  }
});
