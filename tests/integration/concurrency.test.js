import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// admin_audit_log is append-only after migration; unique fixture audit rows are intentionally retained.

const enabled=process.env.RUN_MYSQL_TESTS==='1';
after(async()=>{if(enabled){const {pool}=await import('../../src/database/pool.js');await pool.end();}});

test('MySQL integration: concurrent campaign confirmations create and audit exactly one campaign',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createCampaignFromWizard}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  await migrate();
  const telegramId=String(7300000000000n+(BigInt(Date.now())%100000000000n));
  const title='Concurrent Campaign '+telegramId;
  let campaignId=null;
  try{
    const payload={type:'free',title,description:'Concurrency integration test',codes:2,capacity:null,starts_at:null,ends_at:null,draw_at:null,prizeValue:null};
    await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,?,?)',[telegramId,'confirm',JSON.stringify(payload)]);
    const results=await Promise.allSettled([
      createCampaignFromWizard({telegramUserId:telegramId,actorId:telegramId}),
      createCampaignFromWizard({telegramUserId:telegramId,actorId:telegramId})
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1,'Exactly one concurrent confirmation must succeed.');
    const winner=results.find(x=>x.status==='fulfilled').value;
    campaignId=winner.campaignId;
    const [[campaignCount]]=await pool.execute('SELECT COUNT(*) total FROM campaigns WHERE title=?',[title]);
    const [[auditCount]]=await pool.execute("SELECT COUNT(*) total FROM admin_audit_log WHERE action='campaign.created' AND entity_id=?",[campaignId]);
    assert.equal(Number(campaignCount.total),1);
    assert.equal(Number(auditCount.total),1);
  }finally{
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[telegramId]);
    const [createdRows]=await pool.execute('SELECT id FROM campaigns WHERE title=?',[title]);
    for(const row of createdRows){await pool.execute('DELETE FROM campaigns WHERE id=?',[row.id]);}
  }
});

test('MySQL integration: repeated campaign-copy callbacks share one idempotent result',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {copyCampaign}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  await migrate();
  const actorId=String(7310000000000n+(BigInt(Date.now())%100000000000n));
  const slug='copy-idempotency-'+actorId;
  const key=createHash('sha256').update('campaign-copy-'+actorId).digest('hex');
  let sourceId=null,copyId=null;
  try{
    const [source]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'draft','free',1)",[slug,'Copy Source '+actorId]);
    sourceId=source.insertId;
    const results=await Promise.all([
      copyCampaign({campaignId:sourceId,actorId,idempotencyKey:key}),
      copyCampaign({campaignId:sourceId,actorId,idempotencyKey:key})
    ]);
    assert.equal(results[0].campaignId,results[1].campaignId);
    assert.equal(results.filter(x=>x.alreadyProcessed===false).length,1);
    assert.equal(results.filter(x=>x.alreadyProcessed===true).length,1);
    copyId=results[0].campaignId;
    const [[copyCount]]=await pool.execute('SELECT COUNT(*) total FROM campaigns WHERE id=?',[copyId]);
    assert.equal(Number(copyCount.total),1);
  }finally{
    const [copies]=await pool.execute('SELECT id FROM campaigns WHERE title=?',[`Copy Source ${actorId} (نسخه کپی)`]);
    for(const row of copies){await pool.execute('DELETE FROM campaigns WHERE id=?',[row.id]);}
    if(sourceId)await pool.execute('DELETE FROM campaigns WHERE id=?',[sourceId]);
    await pool.execute('DELETE FROM admin_action_idempotency WHERE idempotency_key=?',[key]);
  }
});

test('MySQL integration: support session is consumed once after concurrent readers observe it',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  await migrate();
  const telegramId=String(7320000000000n+(BigInt(Date.now())%100000000000n));
  let participantId=null,ticketId=null;
  try{
    const [participant]=await pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Support Concurrency','+989121345678','support_concurrency']);
    participantId=participant.insertId;
    await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,category) VALUES(?,'new_message','technical')",[telegramId]);
    let readers=0,releaseReaders;
    const bothObserved=new Promise(resolve=>{releaseReaders=resolve;});
    async function attemptCreateTicket(body){
      const [[observed]]=await pool.execute('SELECT step,category FROM support_sessions WHERE telegram_user_id=?',[telegramId]);
      if(!observed)return null;
      readers++;if(readers===2)releaseReaders();await bothObserved;
      const connection=await pool.getConnection();
      try{
        await connection.beginTransaction();
        const [[session]]=await connection.execute('SELECT step,category FROM support_sessions WHERE telegram_user_id=? FOR UPDATE',[telegramId]);
        if(!session||session.step!=='new_message'){await connection.commit();return null;}
        const ticketNumber='SUP-CI-'+telegramId;
        const [ticket]=await connection.execute("INSERT INTO support_tickets(ticket_number,participant_id,category,subject,status) VALUES(?,?,?,?,'new')",[ticketNumber,participantId,session.category,body.slice(0,180)]);
        await connection.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'participant',?,?)",[ticket.insertId,telegramId,body]);
        await connection.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[telegramId]);
        await connection.commit();return ticket.insertId;
      }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    }
    const results=await Promise.all([attemptCreateTicket('first concurrent message'),attemptCreateTicket('second concurrent message')]);
    assert.equal(results.filter(Boolean).length,1,'Only one request may consume the one-shot support session.');
    ticketId=results.find(Boolean);
    const [[ticketCount]]=await pool.execute('SELECT COUNT(*) total FROM support_tickets WHERE participant_id=?',[participantId]);
    const [[messageCount]]=await pool.execute('SELECT COUNT(*) total FROM support_messages WHERE ticket_id=?',[ticketId]);
    assert.equal(Number(ticketCount.total),1);
    assert.equal(Number(messageCount.total),1);
  }finally{
    await pool.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[telegramId]);
    if(participantId){await pool.execute('DELETE FROM support_messages WHERE ticket_id IN (SELECT id FROM support_tickets WHERE participant_id=?)',[participantId]);await pool.execute('DELETE FROM support_tickets WHERE participant_id=?',[participantId]);await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);}
  }
});

test('MySQL integration: campaign edit wizard is consumed once under concurrent messages',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  await migrate();
  const actorId=String(7330000000000n+(BigInt(Date.now())%100000000000n));
  const slug='edit-wizard-'+actorId;
  let campaignId=null;
  try{
    const [created]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'draft','free',1)",[slug,'Edit Wizard '+actorId]);
    campaignId=created.insertId;
    await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,?,?)',[actorId,'campaign_edit_value',JSON.stringify({campaignId,field:'title'})]);
    let readers=0,releaseReaders;
    const bothObserved=new Promise(resolve=>{releaseReaders=resolve;});
    async function attemptEdit(title){
      const [[observed]]=await pool.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
      if(!observed)return false;
      readers++;if(readers===2)releaseReaders();await bothObserved;
      const connection=await pool.getConnection();
      try{
        await connection.beginTransaction();
        const [[wizard]]=await connection.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=? FOR UPDATE',[actorId]);
        const payload=wizard?(typeof wizard.payload==='string'?JSON.parse(wizard.payload):wizard.payload):null;
        if(!wizard||wizard.step!=='campaign_edit_value'||Number(payload?.campaignId)!==campaignId||payload?.field!=='title')throw new Error('Wizard changed.');
        const [[campaign]]=await connection.execute('SELECT status FROM campaigns WHERE id=? FOR UPDATE',[campaignId]);
        if(!campaign||campaign.status!=='draft')throw new Error('Campaign not editable.');
        await connection.execute('UPDATE campaigns SET title=? WHERE id=?',[title,campaignId]);
        await connection.execute('INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,NULL,?,?,?,?)',[actorId,'campaign.field_updated','campaign',campaignId,JSON.stringify({field:'title'})]);
        await connection.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
        await connection.commit();return true;
      }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    }
    const results=await Promise.allSettled([attemptEdit('Edit Winner A '+actorId),attemptEdit('Edit Winner B '+actorId)]);
    assert.equal(results.filter(x=>x.status==='fulfilled'&&x.value===true).length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const [[auditCount]]=await pool.execute("SELECT COUNT(*) total FROM admin_audit_log WHERE action='campaign.field_updated' AND entity_id=?",[campaignId]);
    assert.equal(Number(auditCount.total),1);
  }finally{
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
    if(campaignId){await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);}
  }
});

test('MySQL integration: admin wizard expected-step cursor CAS allows exactly one concurrent transition',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {advanceAdminWizard}=await import('../../src/modules/admin/admin-wizard-replay.js');
  const actorId=String(7345000000000n+(BigInt(Date.now())%100000000000n));
  const startCursor=Number(950000000+Math.floor(Math.random()*10000000));
  try{
    await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload,last_update_id) VALUES(?,?,?,?)',[actorId,'title',JSON.stringify({}),startCursor]);
    const results=await Promise.allSettled([
      advanceAdminWizard({execute:pool.execute.bind(pool),telegramUserId:actorId,expectedStep:'title',expectedLastUpdateId:startCursor,step:'description',payload:{title:'Concurrent A'},updateId:startCursor+1}),
      advanceAdminWizard({execute:pool.execute.bind(pool),telegramUserId:actorId,expectedStep:'title',expectedLastUpdateId:startCursor,step:'description',payload:{title:'Concurrent B'},updateId:startCursor+2})
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const [[wizard]]=await pool.execute('SELECT step,payload,last_update_id FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
    assert.equal(wizard.step,'description');
    assert.ok([startCursor+1,startCursor+2].includes(Number(wizard.last_update_id)));
    const payload=typeof wizard.payload==='string'?JSON.parse(wizard.payload):wizard.payload;
    assert.ok(['Concurrent A','Concurrent B'].includes(payload.title));
  }finally{await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);}
});

test('MySQL integration: draw publication wizard update and audit are atomic under replay',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  await migrate();
  const actorId=String(7340000000000n+(BigInt(Date.now())%100000000000n));
  const slug='draw-publish-'+actorId;
  let campaignId=null,drawId=null;
  try{
    const [campaign]=await pool.execute("INSERT INTO campaigns(slug,title,status,participation_type,codes_per_entry) VALUES(?,?,'draft','free',1)",[slug,'Draw Publish '+actorId]);
    campaignId=campaign.insertId;
    const [draw]=await pool.execute("INSERT INTO campaign_draws(campaign_id,status,algorithm,seed_hash,candidate_count,created_by) VALUES(?,'prepared','hmac-sha256-v1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,?)",[campaignId,actorId]);
    drawId=draw.insertId;
    await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,?,?)',[actorId,'draw_publication_confirm',JSON.stringify({drawId,reference:'https://proof.example.org/draw/'+drawId})]);
    let readers=0,releaseReaders;
    const bothObserved=new Promise(resolve=>{releaseReaders=resolve;});
    async function attemptPublish(){
      const [[observed]]=await pool.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
      if(!observed)return false;
      readers++;if(readers===2)releaseReaders();await bothObserved;
      const connection=await pool.getConnection();
      try{
        await connection.beginTransaction();
        const [[wizard]]=await connection.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=? FOR UPDATE',[actorId]);
        const payload=wizard?(typeof wizard.payload==='string'?JSON.parse(wizard.payload):wizard.payload):null;
        if(!wizard||wizard.step!=='draw_publication_confirm'||Number(payload?.drawId)!==drawId)throw new Error('Wizard changed.');
        const [[lockedDraw]]=await connection.execute('SELECT campaign_id,status,commitment_published_at FROM campaign_draws WHERE id=? FOR UPDATE',[drawId]);
        if(!lockedDraw||lockedDraw.status!=='prepared'||lockedDraw.commitment_published_at)throw new Error('Draw not publishable.');
        const [updated]=await connection.execute("UPDATE campaign_draws SET commitment_publication_reference=?,commitment_published_at=UTC_TIMESTAMP(),commitment_published_by=? WHERE id=? AND status='prepared' AND commitment_published_at IS NULL",[payload.reference,actorId,drawId]);
        if(!updated.affectedRows)throw new Error('Draw already published.');
        await connection.execute('INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,NULL,?,?,?,?)',[actorId,'draw.commitment_published','campaign_draw',drawId,JSON.stringify({reference:payload.reference})]);
        await connection.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
        await connection.commit();return true;
      }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    }
    const results=await Promise.allSettled([
      attemptPublish(),
      attemptPublish()
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled'&&x.value===true).length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const [[published]]=await pool.execute('SELECT commitment_publication_reference FROM campaign_draws WHERE id=?',[drawId]);
    assert.equal(published.commitment_publication_reference,'https://proof.example.org/draw/'+drawId);
    const [[auditCount]]=await pool.execute("SELECT COUNT(*) total FROM admin_audit_log WHERE action='draw.commitment_published' AND entity_id=?",[drawId]);
    assert.equal(Number(auditCount.total),1);
  }finally{
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[actorId]);
    if(drawId){await pool.execute('DELETE FROM campaign_draws WHERE id=?',[drawId]);}
    if(campaignId)await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
  }
});

test('MySQL integration: registration session records the update that advanced it and rejects replayed advancement',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {saveSession,getSession,advanceSession,clearSession}=await import('../../src/modules/participants/participant.repository.js');
  const telegramId=String(7350000000000n+(BigInt(Date.now())%100000000000n));
  try{
    const startUpdateId=Number(800000000+Math.floor(Math.random()*100000000));
    await saveSession(telegramId,'awaiting_name',{privacyConsentVersion:'ci-v1'},startUpdateId);
    const updateId=startUpdateId+1;
    await pool.execute('UPDATE telegram_user_sessions SET updated_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 25 HOUR) WHERE telegram_user_id=?',[telegramId]);
    await advanceSession(telegramId,'awaiting_name','awaiting_phone',{privacyConsentVersion:'ci-v1',fullName:'Replay Tester'},startUpdateId,updateId);
    const [[freshTimestamp]]=await pool.execute('SELECT updated_at FROM telegram_user_sessions WHERE telegram_user_id=?',[telegramId]);
    assert.ok(new Date(freshTimestamp.updated_at).getTime()>Date.now()-60_000,'advancing a registration session must refresh its 24-hour inactivity TTL');
    const session=await getSession(telegramId);
    assert.equal(session.step,'awaiting_phone');
    assert.equal(session.lastUpdateId,updateId);
    await assert.rejects(advanceSession(telegramId,'awaiting_name','awaiting_phone',{privacyConsentVersion:'ci-v1'},startUpdateId,updateId-1),/Registration update cursor/);
    await assert.rejects(advanceSession(telegramId,'awaiting_phone','awaiting_instagram',{privacyConsentVersion:'ci-v1'},updateId,updateId),/Registration update cursor/);
    const concurrent=await Promise.allSettled([
      advanceSession(telegramId,'awaiting_phone','awaiting_instagram',{privacyConsentVersion:'ci-v1',fullName:'Earlier'},updateId,updateId+1),
      advanceSession(telegramId,'awaiting_phone','awaiting_instagram',{privacyConsentVersion:'ci-v1',fullName:'Later'},updateId,updateId+2)
    ]);
    assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1,'Only one concurrent update may consume a registration step.');
    const afterConcurrent=await getSession(telegramId);
    assert.equal(afterConcurrent.step,'awaiting_instagram');
    assert.ok(afterConcurrent.lastUpdateId===updateId+1||afterConcurrent.lastUpdateId===updateId+2,'The stored cursor must be one of the accepted concurrent updates and must never regress.');
  }finally{await clearSession(telegramId);}
});


test('MySQL integration: final registration completion atomically consumes the expected cursor and is idempotent under concurrency',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {saveSession,getSession,completeProfileFromSession,findByTelegramId}=await import('../../src/modules/participants/participant.repository.js');
  const suffix=String(Date.now()).slice(-8);
  const telegramId=String(7360000000000000n+BigInt(suffix));
  const startUpdateId=Number(900000000+Math.floor(Math.random()*100000000));
  const payload={fullName:'Final Registration Tester',phone:'+9891'+suffix.padStart(8,'0'),privacyConsentVersion:'ci-v1',privacyConsentAt:new Date().toISOString()};
  try{
    await saveSession(telegramId,'awaiting_instagram',payload,startUpdateId);
    await assert.rejects(
      completeProfileFromSession({telegramUserId:telegramId,username:'final_test',fullName:payload.fullName,phone:payload.phone,instagramHandle:'stale_cursor',expectedLastUpdateId:startUpdateId-1,updateId:startUpdateId+1}),
      /مرحله ثبت‌نام تغییر کرده/
    );
    const results=await Promise.all([
      completeProfileFromSession({telegramUserId:telegramId,username:'final_test',fullName:payload.fullName,phone:payload.phone,instagramHandle:'final_first_'+suffix,expectedLastUpdateId:startUpdateId,updateId:startUpdateId+1}),
      completeProfileFromSession({telegramUserId:telegramId,username:'final_test',fullName:payload.fullName,phone:payload.phone,instagramHandle:'final_second_'+suffix,expectedLastUpdateId:startUpdateId,updateId:startUpdateId+2})
    ]);
    assert.equal(results[0].id,results[1].id,'Concurrent final updates must resolve to one participant profile.');
    const profile=await findByTelegramId(telegramId);
    assert.ok(profile,'Exactly one participant profile must be created.');
    assert.equal(profile.privacy_consent_version,'ci-v1');
    assert.equal(await getSession(telegramId),null,'The completed registration session must be consumed atomically.');
  }finally{
    await pool.execute('DELETE FROM telegram_user_sessions WHERE telegram_user_id=?',[telegramId]);
    await pool.execute('DELETE FROM participants WHERE telegram_user_id=?',[telegramId]);
  }
});


test('MySQL integration: privacy re-acceptance and registration advancement cannot overwrite each other',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {saveSession,getSession,advanceSession,acceptPrivacyConsentSession,clearSession}=await import('../../src/modules/participants/participant.repository.js');
  const telegramId=String(7370000000000000n+(BigInt(Date.now())%1000000000n));
  const startUpdateId=Number(970000000+Math.floor(Math.random()*10000000));
  const original={fullName:'Consent Race Tester',privacyConsentVersion:'ci-v1',privacyConsentAt:'2026-11-25T10:00:00.000Z'};
  try{
    await saveSession(telegramId,'awaiting_phone',original,startUpdateId);
    const results=await Promise.allSettled([
      acceptPrivacyConsentSession({telegramUserId:telegramId,expectedLastUpdateId:startUpdateId,updateId:startUpdateId+2,version:'ci-v2',acceptedAt:new Date()}),
      advanceSession(telegramId,'awaiting_phone','awaiting_instagram',{...original,phone:'+989121234567'},startUpdateId,startUpdateId+1)
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1,'Only one concurrent update may consume the exact registration cursor.');
    assert.equal(results.filter(x=>x.status==='rejected').length,1,'The losing stale update must not overwrite the winner.');
    const current=await getSession(telegramId);
    assert.ok(current);
    if(current.lastUpdateId===startUpdateId+1){
      assert.equal(current.step,'awaiting_instagram');
      assert.equal(current.payload.phone,'+989121234567');
      assert.equal(current.payload.privacyConsentVersion,'ci-v1');
    }else{
      assert.equal(current.lastUpdateId,startUpdateId+2);
      assert.equal(current.step,'awaiting_phone');
      assert.equal(current.payload.phone,undefined);
      assert.equal(current.payload.privacyConsentVersion,'ci-v2');
    }
  }finally{await clearSession(telegramId);}
});


test('MySQL integration: participant profile/support session starts serialize and stale cancel cannot clear a newer session',{skip:!enabled},async()=>{
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {startProfileChangeSession,startUserSupportSession,cancelProfileChangeSession,cancelUserSupportSession}=await import('../../src/bot/handlers/user.handler.js');
  await migrate();
  const telegramId=String(7380000000000n+(BigInt(Date.now())%100000000000n));
  const phone='+98912'+String(Date.now()).slice(-8);
  let participantId=null;
  try{
    const [participant]=await pool.execute('INSERT INTO participants(telegram_user_id,full_name,phone,instagram_handle) VALUES(?,?,?,?)',[telegramId,'Participant Session Concurrency',phone,'session_'+telegramId.slice(-8)]);
    participantId=participant.insertId;

    const concurrent=await Promise.all([
      startProfileChangeSession({telegramUserId:telegramId,step:'full_name',updateId:980000001}),
      startUserSupportSession({telegramUserId:telegramId,step:'new_message',category:'technical',updateId:980000002})
    ]);
    assert.ok(concurrent.some(Boolean),'The newest concurrent flow start must succeed.');
    const [[counts]]=await pool.execute(
      "SELECT (SELECT COUNT(*) FROM profile_change_sessions WHERE telegram_user_id=?) profile_count,(SELECT COUNT(*) FROM support_sessions WHERE telegram_user_id=? AND step IN ('new_message','user_reply')) support_count",
      [telegramId,telegramId]
    );
    assert.equal(Number(counts.profile_count),0,'The newer support flow must replace the older profile flow.');
    assert.equal(Number(counts.support_count),1,'Exactly one participant text session may remain after concurrent starts.');
    const [[winner]]=await pool.execute("SELECT last_update_id FROM support_sessions WHERE telegram_user_id=? AND step='new_message'",[telegramId]);
    assert.equal(Number(winner?.last_update_id),980000002,'The higher Telegram update ID must win regardless of transaction scheduling.');

    assert.equal(await startProfileChangeSession({telegramUserId:telegramId,step:'full_name',updateId:980000003}),true);
    assert.equal(await startUserSupportSession({telegramUserId:telegramId,step:'new_message',category:'technical',updateId:980000004}),true);
    assert.equal(await cancelProfileChangeSession({telegramUserId:telegramId,expectedUpdateId:980000003}),false,'A stale profile cancel must not delete the newer support session.');
    const [[supportStillActive]]=await pool.execute("SELECT COUNT(*) total FROM support_sessions WHERE telegram_user_id=? AND step='new_message' AND last_update_id=980000004",[telegramId]);
    assert.equal(Number(supportStillActive.total),1);
    assert.equal(await cancelUserSupportSession({telegramUserId:telegramId,expectedUpdateId:980000004}),true);

    assert.equal(await startProfileChangeSession({telegramUserId:telegramId,step:'instagram_handle',updateId:980000005}),true);
    assert.equal(await cancelProfileChangeSession({telegramUserId:telegramId,expectedUpdateId:980000005}),true);
    assert.equal(await startUserSupportSession({telegramUserId:telegramId,step:'new_message',category:'campaign',updateId:980000006}),true);
    assert.equal(await startUserSupportSession({telegramUserId:telegramId,step:'new_message',category:'financial',updateId:980000007}),true);
    assert.equal(await cancelUserSupportSession({telegramUserId:telegramId,expectedUpdateId:980000006}),false,'An older support cancel must not delete a refreshed support session.');
    assert.equal(await cancelUserSupportSession({telegramUserId:telegramId,expectedUpdateId:980000007}),true);
  }finally{
    await pool.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[telegramId]);
    await pool.execute('DELETE FROM profile_change_sessions WHERE telegram_user_id=?',[telegramId]);
    if(participantId)await pool.execute('DELETE FROM participants WHERE id=?',[participantId]);
  }
});
