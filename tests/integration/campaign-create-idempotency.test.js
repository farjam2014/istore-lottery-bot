import test from 'node:test';
import assert from 'node:assert/strict';

const enabled=process.env.RUN_MYSQL_TESTS==='1';

test('MySQL integration: concurrent campaign confirmation creates one draft and one audit record',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Campaign creation integration must use an isolated database');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createCampaignFromWizard}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  const adminId=String(950000000000n+(BigInt(Date.now())%100000000000n));
  const suffix=String(Date.now());
  const title='Concurrent campaign '+suffix;
  const payload={
    title,description:'Idempotency test',posterFileId:null,prizeTitle:'Test prize',
    prizeDescription:'',prizeValue:null,type:'free',price:0,paymentMethods:[],
    starts_at:null,ends_at:null,draw_at:null,terms:'',capacity:1,codes:2
  };
  let campaignId;
  try{
    await migrate();
    await pool.execute(
      "INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'confirm',?)",
      [adminId,JSON.stringify(payload)]
    );
    const outcomes=await Promise.allSettled([
      createCampaignFromWizard({adminId}),
      createCampaignFromWizard({adminId})
    ]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1,'Only one concurrent confirmation may create a campaign');
    assert.equal(outcomes.filter(x=>x.status==='rejected').length,1,'The second confirmation must see the consumed wizard');
    campaignId=outcomes.find(x=>x.status==='fulfilled').value.id;
    const [[count]]=await pool.execute('SELECT COUNT(*) total FROM campaigns WHERE title=?',[title]);
    assert.equal(Number(count.total),1);
    const [[audit]]=await pool.execute(
      "SELECT COUNT(*) total FROM admin_audit_log WHERE admin_telegram_id=? AND action='campaign.created' AND entity_type='campaign' AND entity_id=?",
      [adminId,campaignId]
    );
    assert.equal(Number(audit.total),1,'Campaign creation and audit must commit exactly once');
    const [[wizard]]=await pool.execute('SELECT COUNT(*) total FROM admin_wizards WHERE telegram_user_id=?',[adminId]);
    assert.equal(Number(wizard.total),0,'The confirm wizard must be consumed in the same transaction');
  }finally{
    if(campaignId){
      await pool.execute("DELETE FROM admin_audit_log WHERE admin_telegram_id=? AND action='campaign.created' AND entity_id=?",[adminId,campaignId]);
      await pool.execute('DELETE FROM campaigns WHERE id=?',[campaignId]);
    }
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[adminId]);
  }
});

test.after(async()=>{
  if(enabled){
    const {pool}=await import('../../src/database/pool.js');
    await pool.end();
  }
});


test('MySQL integration: invalid campaign schedule rolls back and preserves the admin wizard',{skip:!enabled},async()=>{
  const db=process.env.MYSQL_DATABASE||'';
  assert.match(db,/_ci$|_test$/,'Campaign creation integration must use an isolated database');
  const {pool}=await import('../../src/database/pool.js');
  const {migrate}=await import('../../src/database/migrate.js');
  const {createCampaignFromWizard}=await import('../../src/modules/campaigns/campaign-admin.service.js');
  const adminId=String(960000000000n+(BigInt(Date.now())%100000000000n));
  const title='Invalid campaign '+Date.now();
  const payload={title,description:'',type:'free',price:0,codes:1,capacity:null,starts_at:'2026-12-02 00:00:00',ends_at:'2026-12-01 00:00:00',draw_at:null};
  try{
    await migrate();
    await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'confirm',?)",[adminId,JSON.stringify(payload)]);
    await assert.rejects(createCampaignFromWizard({adminId}),/زمان پایان باید بعد از شروع باشد/);
    const [[campaigns]]=await pool.execute('SELECT COUNT(*) total FROM campaigns WHERE title=?',[title]);
    assert.equal(Number(campaigns.total),0,'Invalid schedule must not create a campaign');
    const [[wizard]]=await pool.execute('SELECT step FROM admin_wizards WHERE telegram_user_id=?',[adminId]);
    assert.equal(wizard.step,'confirm','Invalid payload must leave the wizard available for correction');
  }finally{
    await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[adminId]);
  }
});
