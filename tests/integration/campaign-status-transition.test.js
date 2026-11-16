import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: campaign status actions are idempotent and expired paused campaigns close',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Campaign status integration must use an isolated test database');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {setCampaignStatus}=await import('../../src/modules/campaigns/campaign-status.service.js');
  const {processCampaignSchedule}=await import('../../src/modules/campaigns/campaign-scheduler.js');
  const adminId='900000003';
  const suffix=String(Date.now());
  const ids=[];
  const now=Date.now();
  const dt=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ');
  const past=dt(now-3600000),future=dt(now+3600000),futureFar=dt(now+7200000);
  const create=async(status,startsAt,endsAt,label)=>{
    const [row]=await pool.execute(
      'INSERT INTO campaigns(slug,title,status,participation_type,entry_price,starts_at,ends_at) VALUES(?,?,? ,\'free\',0,?,?)',
      ['status-test-'+suffix+'-'+label,'Status test '+label,status,startsAt,endsAt]
    );
    ids.push(String(row.insertId));
    return String(row.insertId);
  };
  try{
    await migrate();
    const [[dueBefore]]=await pool.execute(
      "SELECT COUNT(*) total FROM campaigns WHERE (status='scheduled' AND starts_at<=UTC_TIMESTAMP()) OR (status IN ('open','paused') AND ends_at IS NOT NULL AND ends_at<=UTC_TIMESTAMP())"
    );
    assert.equal(Number(dueBefore.total),0,'The isolated test database must not contain due campaigns before this scenario');

    const openFuture=await create('open',past,future,'open-future');
    const openEnded=await create('open',past,past,'open-ended');
    const pausedEnded=await create('paused',past,past,'paused-ended');
    const scheduledActive=await create('scheduled',past,future,'scheduled-active');
    const scheduledFuture=await create('scheduled',future,futureFar,'scheduled-future');
    const scheduledEnded=await create('scheduled',past,past,'scheduled-ended');
    const draftFuture=await create('draft',future,futureFar,'draft-future');
    const draftEnded=await create('draft',past,past,'draft-ended');

    const pauses=await Promise.all([
      setCampaignStatus({campaignId:openFuture,actorId:adminId,target:'pause'}),
      setCampaignStatus({campaignId:openFuture,actorId:adminId,target:'pause'})
    ]);
    assert.equal(pauses.filter(x=>x.changed).length,1,'Two concurrent pause callbacks must only transition once');
    const [[paused]]=await pool.execute('SELECT status FROM campaigns WHERE id=?',[openFuture]);
    assert.equal(paused.status,'paused');

    const closedByAdmin=await setCampaignStatus({campaignId:openEnded,actorId:adminId,target:'pause'});
    assert.equal(closedByAdmin.to,'closed','An already-ended open campaign must close, not become paused');
    const pausedSchedule=await setCampaignStatus({campaignId:scheduledFuture,actorId:adminId,target:'pause'});
    assert.equal(pausedSchedule.to,'paused','A future scheduled campaign must be pausable');

    const activations=await Promise.all([
      setCampaignStatus({campaignId:draftFuture,actorId:adminId,target:'activate'}),
      setCampaignStatus({campaignId:draftFuture,actorId:adminId,target:'activate'})
    ]);
    assert.equal(activations.filter(x=>x.changed).length,1,'Two concurrent activate callbacks must only transition once');
    const [[scheduled]]=await pool.execute('SELECT status FROM campaigns WHERE id=?',[draftFuture]);
    assert.equal(scheduled.status,'scheduled');

    const endedDraft=await setCampaignStatus({campaignId:draftEnded,actorId:adminId,target:'activate'});
    assert.equal(endedDraft.to,'closed','An expired draft must not be opened');

    const processed=await processCampaignSchedule({limit:20});
    assert.equal(processed,3,'Scheduler should process the expired paused campaign and two scheduled campaigns');
    const [states]=await pool.execute(
      'SELECT id,status FROM campaigns WHERE id IN ('+ids.map(()=>'?').join(',')+')',
      ids
    );
    const stateById=new Map(states.map(row=>[String(row.id),row.status]));
    assert.equal(stateById.get(pausedEnded),'closed');
    assert.equal(stateById.get(scheduledActive),'open');
    assert.equal(stateById.get(scheduledEnded),'closed');
    assert.equal(stateById.get(openFuture),'paused');
    assert.equal(stateById.get(openEnded),'closed');
    assert.equal(stateById.get(draftFuture),'scheduled');
    assert.equal(stateById.get(draftEnded),'closed');
    assert.equal(stateById.get(scheduledFuture),'paused');

    const [[audit]]=await pool.execute(
      "SELECT COUNT(*) total FROM admin_audit_log WHERE admin_telegram_id=? AND action='campaign.status_changed' AND entity_type='campaign' AND entity_id IN ("+ids.map(()=>'?').join(',')+")",
      [adminId,...ids]
    );
    assert.equal(Number(audit.total),5,'Only actual admin state transitions should be audited');
  }finally{
    if(ids.length){
      const placeholders=ids.map(()=>'?').join(',');
      await pool.execute("DELETE FROM admin_audit_log WHERE action='campaign.auto_status_changed' AND entity_type='campaign' AND entity_id IN ("+placeholders+")",ids);
      await pool.execute("DELETE FROM admin_audit_log WHERE admin_telegram_id=? AND action='campaign.status_changed' AND entity_type='campaign' AND entity_id IN ("+placeholders+")",[adminId,...ids]);
      await pool.execute('DELETE FROM campaigns WHERE id IN ('+placeholders+')',ids);
    }
  }
});

test.after(async()=>{
  if(enabled){
    const {pool}=await import('../../src/database/pool.js');
    await pool.end();
  }
});
