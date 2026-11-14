'use strict';
const crypto = require('node:crypto');
const { normalizePhone, validPhone, normalizeInstagram, validInstagram, validFullName } = require('./domain');

function createAdminTelegram({ db, tg, tgDocument, adminId, registrationOpen, campaignService, bankCardService, drawService }) {
  const pending = new Map();
  const uiMessageIds = new Map();
  const callbackInFlight = new Map();
  const actionInFlight = new Map();
  const completedCallbackIds = new Set();
  const completedCallbackOrder = [];
  const isAdmin = (q) => String(q?.from?.id || '') === String(adminId) && q?.message?.chat?.type === 'private';
  const menu = [
    [{ text: '📊 داشبورد', callback_data: 'adm:stats' }, { text: '👥 مشتریان', callback_data: 'adm:participants' }],
    [{ text: '🎟 خروجی کدها', callback_data: 'adm:export' }, { text: '🧩 کمپین‌ها', callback_data: 'adm:campaigns' }],
    [{ text: '💳 مدیریت کارت‌های بانکی', callback_data: 'adm:cards' }],
    [{ text: '💳 سفارش‌ها و رسیدها', callback_data: 'adm:orders' }],
    [{ text: '📝 درخواست‌های اصلاح پروفایل', callback_data: 'adm:profile-requests' }],
    [{ text: '💬 تیکت‌های پشتیبانی', callback_data: 'adm:support' }],
    [{ text: '🏆 قرعه‌کشی کمپین', callback_data: 'adm:draws' }, { text: '🧾 رخدادها', callback_data: 'adm:audit' }],
    [{ text: '🔄 تازه‌سازی', callback_data: 'adm:home' }]
  ];
  const keyboard = (rows) => ({ inline_keyboard: rows });
  async function adminMessage(payload) {
    const chat = payload.chat_id;
    const key = String(chat);
    const messageId = uiMessageIds.get(key);
    if (messageId) {
      try {
        const edited = await tg('editMessageText', {
          chat_id: chat,
          message_id: messageId,
          text: payload.text,
          ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {})
        });
        if (edited?.ok !== false) return edited;
      } catch (error) {
        // Fall back to a new message if Telegram no longer permits editing this one.
      }
    }
    const sent = await tg('sendMessage', payload);
    const sentId = sent?.result?.message_id ?? sent?.message_id;
    if (sentId) uiMessageIds.set(key, sentId);
    return sent;
  }
  const home = (chat, text = '🛠 مدیریت iStore\nیک بخش را انتخاب کنید:') =>
    adminMessage({ chat_id: chat, text, reply_markup: keyboard(menu) });
  const digits = (v) => String(v ?? '').replace(/[۰-۹٠-٩]/g, c => {
    const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
    const n = fa.indexOf(c); return String(n >= 0 ? n : ar.indexOf(c));
  });
  async function audit(action, type, id, details = {}) {
    await db.execute(
      'INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',
      [String(adminId), action, type, id == null ? null : String(id), JSON.stringify(details)]
    );
  }
  async function stats(chat) {
    const [[sessions]] = await db.query("SELECT COUNT(*) pending FROM telegram_sessions");
    const [[webhooks]] = await db.query("SELECT COUNT(*) failed FROM webhook_inbox WHERE status='failed'");
    const [[outbox]] = await db.query("SELECT COUNT(*) failed FROM telegram_notification_outbox WHERE status='failed'");
    const [[campaigns]] = await db.query("SELECT COUNT(*) total, SUM(status='open') open, SUM(status='draft') draft, SUM(status='paused') paused, SUM(status='closed') closed FROM campaigns");
    const [[participants]] = await db.query("SELECT COUNT(*) total, SUM(status='active') active FROM participants");
    const [[entries]] = await db.query("SELECT COUNT(*) total, SUM(status='active') active, SUM(status='pending') pending FROM campaign_entries");
    const [[codes]] = await db.query("SELECT COUNT(*) total FROM campaign_codes WHERE status='active'");
    const [[orders]] = await db.query("SELECT COUNT(*) total, SUM(status='pending_payment') pending, SUM(status='receipt_submitted') receipts, SUM(status='approved') approved, SUM(status='rejected') rejected FROM payment_orders");
    const [revenue] = await db.query("SELECT currency,SUM(amount) total FROM payment_transactions WHERE status='confirmed' GROUP BY currency ORDER BY currency");
    const [[profileRequests]] = await db.query("SELECT COUNT(*) pending FROM profile_change_requests WHERE status='pending'");
    const money = revenue.length ? revenue.map(x => Number(x.total || 0).toLocaleString('en-US')+' '+x.currency).join(' · ') : '۰';
    return adminMessage({ chat_id: chat, text:
      '📊 داشبورد مدیریتی USTORE\n\n' +
      '🧩 کمپین‌ها: '+Number(campaigns.total||0)+' | باز: '+Number(campaigns.open||0)+' | پیش‌نویس: '+Number(campaigns.draft||0)+' | متوقف: '+Number(campaigns.paused||0)+' | بسته: '+Number(campaigns.closed||0)+
      '\n👥 پروفایل مشتریان: '+Number(participants.total||0)+' | فعال: '+Number(participants.active||0)+
      '\n🧭 عضویت کمپین: '+Number(entries.active||0)+' فعال از '+Number(entries.total||0)+' | معلق: '+Number(entries.pending||0)+
      '\n🎟 کدهای فعال: '+Number(codes.total||0)+
      '\n💳 سفارش‌ها: '+Number(orders.total||0)+' | منتظر پرداخت: '+Number(orders.pending||0)+' | رسید در انتظار: '+Number(orders.receipts||0)+
      '\n✅ پرداخت تأییدشده: '+Number(orders.approved||0)+' | ردشده: '+Number(orders.rejected||0)+
      '\n💰 تراکنش تأییدشده: '+money+
      '\n📝 درخواست اصلاح پروفایل معلق: '+Number(profileRequests.pending||0)+
      '\n⌛ نشست نیمه‌کاره: '+Number(sessions.pending||0)+
      '\n⚠️ خطاهای Webhook: '+Number(webhooks.failed||0)+' | اعلان ناموفق: '+Number(outbox.failed||0),
      reply_markup: keyboard([[{text:'🧩 کمپین‌ها',callback_data:'adm:campaigns'},{text:'👥 مشتریان',callback_data:'adm:participants'}],[{text:'💳 سفارش‌ها',callback_data:'adm:orders'},{text:'🏆 قرعه‌کشی',callback_data:'adm:draws'}],[{text:'📝 درخواست‌های اصلاح',callback_data:'adm:profile-requests'},{text:'🧾 رخدادها',callback_data:'adm:audit'}],[{text:'📈 گزارش کمپین‌ها',callback_data:'adm:reports'}],[{text:'↩️ منوی اصلی',callback_data:'adm:home'}]]) });
  }
  async function participantList(chat, page=0) {
    const p=Math.max(0,Math.min(10000,Number(page)||0));
    const [rows]=await db.execute(`SELECT p.id,p.full_name,p.phone,p.instagram,p.status,
      COUNT(DISTINCT ce.id) AS campaign_count,COUNT(DISTINCT cc.id) AS active_codes
      FROM participants p
      LEFT JOIN campaign_entries ce ON ce.participant_id=p.id
      LEFT JOIN campaign_codes cc ON cc.participant_id=p.id AND cc.status='active'
      GROUP BY p.id,p.full_name,p.phone,p.instagram,p.status
      ORDER BY p.id DESC LIMIT 8 OFFSET ?`,[p*8]);
    const buttons=rows.map(x=>[{text:(x.status==='active'?'✅ ':'⏸ ')+String(x.full_name).slice(0,24)+' · '+Number(x.active_codes)+' کد',callback_data:'adm:participant:'+x.id}]);
    const nav=[];if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'adm:participants:'+(p-1)});if(rows.length===8)nav.push({text:'بعدی ➡️',callback_data:'adm:participants:'+(p+1)});if(nav.length)buttons.push(nav);
    buttons.push([{text:'↻ تازه‌سازی',callback_data:'adm:participants:0'},{text:'🏠 منو',callback_data:'adm:home'}]);
    return adminMessage({chat_id:chat,text:'👥 مشتریان USTORE · صفحه '+(p+1)+'\nهر ردیف یک پروفایل اصلی است؛ عضویت‌ها و کدها متعلق به کمپین‌ها هستند.',reply_markup:keyboard(buttons)});
  }
  async function participantDetail(chat,id) {
    if(!/^\d+$/.test(String(id)))return adminMessage({chat_id:chat,text:'شناسه مشتری نامعتبر است.'});
    const [[p]]=await db.execute('SELECT id,telegram_user_id,chat_id,full_name,phone,instagram,status,created_at FROM participants WHERE id=? LIMIT 1',[id]);
    if(!p)return adminMessage({chat_id:chat,text:'مشتری پیدا نشد.'});
    const [rows]=await db.execute(`SELECT c.name,ce.status,COUNT(cc.id) AS codes
      FROM campaign_entries ce JOIN campaigns c ON c.id=ce.campaign_id
      LEFT JOIN campaign_codes cc ON cc.entry_id=ce.id AND cc.status='active'
      WHERE ce.participant_id=? GROUP BY c.id,c.name,ce.status ORDER BY c.id DESC LIMIT 20`,[id]);
    const memberships=rows.length?rows.map(x=>'• '+x.name+' · '+x.status+' · '+x.codes+' کد').join('\n'):'هنوز در کمپینی عضو نشده است.';
    return adminMessage({chat_id:chat,text:'👤 پروفایل مشتری #'+p.id+'\n\nنام: '+p.full_name+'\nموبایل: '+p.phone+'\nاینستاگرام: @'+p.instagram+'\nTelegram ID: '+p.telegram_user_id+'\nوضعیت: '+p.status+'\nثبت: '+p.created_at+'\n\nعضویت کمپین‌ها:\n'+memberships,reply_markup:keyboard([[{text:p.status==='active'?'⏸ غیرفعال‌سازی':'✅ فعال‌سازی',callback_data:'adm:participant-status:'+p.id+':'+(p.status==='active'?'inactive':'active')}],[{text:'↩️ فهرست مشتریان',callback_data:'adm:participants:0'},{text:'🏠 منو',callback_data:'adm:home'}]])});
  }
  async function campaignDrawList(chat) {
    const [rows]=await db.execute("SELECT id,name,status,draw_method FROM campaigns WHERE status IN ('closed','drawn') ORDER BY id DESC LIMIT 30");
    if(!rows.length)return adminMessage({chat_id:chat,text:'برای قرعه‌کشی، ابتدا یک کمپین را ببندید. کمپین بسته‌شده در این فهرست نمایش داده می‌شود.',reply_markup:keyboard([[{text:'مدیریت کمپین‌ها',callback_data:'adm:campaigns'}],[{text:'منوی اصلی',callback_data:'adm:home'}]])});
    const buttons=rows.map(x=>[{text:'#'+x.id+' · '+x.name+' · '+x.status,callback_data:'adm:draw-campaign:'+x.id}]);
    buttons.push([{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    return adminMessage({chat_id:chat,text:'🏆 انتخاب کمپین برای مشاهده یا اجرای قرعه‌کشی:',reply_markup:keyboard(buttons)});
  }
  async function campaignDrawAction(chat,campaignId) {
    if(!/^\d+$/.test(String(campaignId)))return adminMessage({chat_id:chat,text:'شناسه کمپین نامعتبر است.'});
    const [[campaign]]=await db.execute('SELECT id,name,status,draw_method FROM campaigns WHERE id=? LIMIT 1',[campaignId]);
    if(!campaign)return adminMessage({chat_id:chat,text:'کمپین پیدا نشد.'});
    const [draws]=await db.execute('SELECT id,draw_number,status,method,snapshot_hash FROM campaign_draws WHERE campaign_id=? ORDER BY draw_number DESC LIMIT 5',[campaignId]);
    const buttons=[];
    if(campaign.status==='closed')buttons.push([{text:'📸 آماده‌سازی snapshot قرعه‌کشی',callback_data:'adm:draw-prepare:'+campaignId}]);
    for(const d of draws){buttons.push([{text:'قرعه‌کشی #'+d.draw_number+' · '+d.status,callback_data:'adm:draw-view:'+d.id}]);if(d.status==='prepared'&&['system','hybrid'].includes(d.method))buttons.push([{text:'▶️ ادامه اجرای قرعه‌کشی #'+d.draw_number,callback_data:'adm:draw-run:'+d.id}]);if(d.status==='prepared'&&['live_wheel','hybrid'].includes(d.method))buttons.push([{text:'🎡 ثبت نتیجه گردونه زنده #'+d.draw_number,callback_data:'adm:draw-live:'+d.id+':0'}]);}
    buttons.push([{text:'↩️ فهرست کمپین‌ها',callback_data:'adm:draws'}]);
    return adminMessage({chat_id:chat,text:'🏆 '+campaign.name+'\nوضعیت: '+campaign.status+'\nروش: '+campaign.draw_method+'\n\nبرای قرعه‌کشی، ابتدا snapshot واجدان شرایط ثبت می‌شود.',reply_markup:keyboard(buttons)});
  }
  async function prepareCampaignDraw(chat,campaignId) {
    try {
      const result=await drawService.prepareDraw(Number(campaignId));
      if(result.method==='system'||result.method==='hybrid'){
        const selected=await drawService.runSystemDraw(result.drawId);
        return adminMessage({chat_id:chat,text:'🎲 نتیجه اولیه آماده شد و هنوز نهایی نیست.\nقرعه‌کشی: #'+result.drawId+'\nواجدان: '+result.candidates+'\nSnapshot SHA-256: '+result.snapshotHash+'\n\nبرندگان تا تأیید نهایی قطعی نیستند.',reply_markup:keyboard([[{text:'✅ تأیید نتیجه',callback_data:'adm:draw-approve:'+result.drawId}],[{text:'↩️ بازگشت',callback_data:'adm:draw-campaign:'+campaignId}]])});
      }
      return adminMessage({chat_id:chat,text:'Snapshot قرعه‌کشی #'+result.drawId+' آماده شد. تعداد واجدان: '+result.candidates+'\nروش کمپین گردونه زنده است؛ نتایج باید از مسیر ثبت نتیجه زنده و با شواهد ثبت شوند. هیچ برنده‌ای خودکار انتخاب نشده است.',reply_markup:keyboard([[{text:'↩️ بازگشت',callback_data:'adm:draw-campaign:'+campaignId}]])});
    } catch(e) { return adminMessage({chat_id:chat,text:'آماده‌سازی قرعه‌کشی انجام نشد: '+e.message}); }
  }
  async function resumeCampaignDraw(chat,drawId) {
    if(!/^\\d+$/.test(String(drawId)))return adminMessage({chat_id:chat,text:'شناسه قرعه‌کشی نامعتبر است.'});
    try {
      const [[draw]]=await db.execute('SELECT id,campaign_id,draw_number,status,method,snapshot_hash FROM campaign_draws WHERE id=? LIMIT 1',[drawId]);
      if(!draw)return adminMessage({chat_id:chat,text:'قرعه‌کشی پیدا نشد.'});
      if(draw.status!=='prepared'||!['system','hybrid'].includes(draw.method))return adminMessage({chat_id:chat,text:'این قرعه‌کشی در وضعیت قابل ادامه نیست.'});
      const result=await drawService.runSystemDraw(Number(drawId));
      return adminMessage({chat_id:chat,text:'🎲 اجرای قرعه‌کشی بازیابی و نتیجه اولیه ثبت شد.\nقرعه‌کشی: #'+draw.draw_number+'\nSnapshot SHA-256: '+draw.snapshot_hash+'\n\nنتیجه هنوز نهایی نیست و باید تأیید شود.',reply_markup:keyboard([[{text:'✅ تأیید نتیجه',callback_data:'adm:draw-approve:'+drawId}],[{text:'مشاهده جزئیات',callback_data:'adm:draw-view:'+drawId}],[{text:'↩️ بازگشت',callback_data:'adm:draw-campaign:'+draw.campaign_id}]])});
    } catch(e) { return adminMessage({chat_id:chat,text:'بازیابی اجرای قرعه‌کشی انجام نشد: '+e.message}); }
  }
  async function liveWheelCandidatePage(chat,drawId,page=0) {
    if(!/^\\d+$/.test(String(drawId)))return adminMessage({chat_id:chat,text:'شناسه قرعه‌کشی نامعتبر است.'});
    const p=Math.max(0,Math.min(10000,Number(page)||0));
    const [[draw]]=await db.execute("SELECT id,campaign_id,draw_number,status,method,winner_count,alternate_count FROM campaign_draws WHERE id=? LIMIT 1",[drawId]);
    if(!draw||draw.status!=='prepared'||!['live_wheel','hybrid'].includes(draw.method))return adminMessage({chat_id:chat,text:'این قرعه‌کشی برای ثبت نتیجه گردونه آماده نیست.'});
    const [[total]]=await db.execute("SELECT COUNT(*) AS total FROM draw_candidates WHERE draw_id=? AND eligibility='eligible'",[drawId]);
    const [rows]=await db.execute("SELECT candidate_reference FROM draw_candidates WHERE draw_id=? AND eligibility='eligible' ORDER BY candidate_reference LIMIT 30 OFFSET ?",[drawId,p*30]);
    const body=rows.map(x=>x.candidate_reference).join('\\n');
    const buttons=[];
    const nav=[];if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'adm:draw-live:'+drawId+':'+(p-1)});if((p+1)*30<Number(total.total))nav.push({text:'بعدی ➡️',callback_data:'adm:draw-live:'+drawId+':'+(p+1)});if(nav.length)buttons.push(nav);
    buttons.push([{text:'📝 شروع ثبت نتیجه',callback_data:'adm:draw-live-start:'+drawId}]);
    buttons.push([{text:'↩️ بازگشت',callback_data:'adm:draw-campaign:'+draw.campaign_id}]);
    return adminMessage({chat_id:chat,text:'🎡 فهرست شناسه‌های واجدان قرعه‌کشی #'+draw.draw_number+'\\nصفحه '+(p+1)+' · مجموع واجدان: '+Number(total.total)+'\\nتعداد نتایج لازم: '+(Number(draw.winner_count)+Number(draw.alternate_count))+'\\n\\nشناسه‌ها را دقیقاً از این فهرست بردارید:\\n'+(body||'موردی وجود ندارد.'),reply_markup:keyboard(buttons)});
  }
  async function startLiveWheelResult(chat,drawId) {
    const [[draw]]=await db.execute("SELECT id,campaign_id,draw_number,status,method,winner_count,alternate_count FROM campaign_draws WHERE id=? LIMIT 1",[drawId]);
    if(!draw||draw.status!=='prepared'||!['live_wheel','hybrid'].includes(draw.method))return adminMessage({chat_id:chat,text:'این قرعه‌کشی در وضعیت قابل ثبت نیست.'});
    pending.set(String(adminId),{type:'live-wheel-result',drawId:String(drawId),step:'references',references:null,externalReference:null,expires:Date.now()+1800000,required:Number(draw.winner_count)+Number(draw.alternate_count)});
    return adminMessage({chat_id:chat,text:'ثبت نتیجه گردونه زنده · قرعه‌کشی #'+draw.draw_number+'\\n\\n'+pending.get(String(adminId)).required+' شناسه واجد را با ویرگول یا فاصله جدا کنید و بفرستید. برای مشاهده شناسه‌ها از فهرست قرعه‌کشی استفاده کنید.\\n\\nبرای لغو /cancel را بفرستید.',reply_markup:keyboard([[{text:'📋 مشاهده شناسه‌های واجدان',callback_data:'adm:draw-live:'+drawId+':0'},{text:'✖️ لغو',callback_data:'adm:draw-live-cancel'}]])});
  }
  async function approveCampaignDraw(chat,drawId) {
    try { await drawService.approveDraw(Number(drawId)); return adminMessage({chat_id:chat,text:'✅ نتیجه قرعه‌کشی تأیید و کمپین نهایی شد.',reply_markup:keyboard([[{text:'🏆 قرعه‌کشی‌ها',callback_data:'adm:draws'}],[{text:'📊 داشبورد',callback_data:'adm:stats'}]])}); }
    catch(e) { return adminMessage({chat_id:chat,text:'تأیید نتیجه انجام نشد: '+e.message}); }
  }
  async function exportCsv(chat,status='all',period='all') {
    if(!['all','active','inactive'].includes(status)||!['all','today','7d','30d'].includes(period))return adminMessage({chat_id:chat,text:'فیلتر خروجی نامعتبر است.'});
    const clauses=["p.status <> 'deleted'"],params=[];
    if(status!=='all'){clauses.push('p.status = ?');params.push(status);}
    if(period==='today')clauses.push('p.created_at >= CURDATE()');
    if(period==='7d')clauses.push('p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)');
    if(period==='30d')clauses.push('p.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
    const [rows]=await db.execute(`SELECT p.full_name,p.phone,p.instagram,c.name AS campaign_name,cc.code,ce.status AS membership_status,cc.issued_at
      FROM participants p LEFT JOIN campaign_entries ce ON ce.participant_id=p.id
      LEFT JOIN campaigns c ON c.id=ce.campaign_id
      LEFT JOIN campaign_codes cc ON cc.entry_id=ce.id AND cc.status='active'
      WHERE ${clauses.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC,cc.id ASC`,params);
    const cell=v=>{let x=String(v??'');if(/^[\s]*[=+\-@]/.test(x))x="'"+x;return '"'+x.replace(/"/g,'""')+'"';};
    const csv='\uFEFF'+[['نام','موبایل','اینستاگرام','کمپین','کد','وضعیت عضویت','زمان صدور'],...rows.map(x=>[x.full_name,x.phone,'@'+x.instagram,x.campaign_name||'',x.code||'',x.membership_status||'',x.issued_at||''])].map(row=>row.map(cell).join(',')).join('\r\n');
    return tgDocument(chat,'ustore-campaign-participants.csv',csv,'text/csv;charset=utf-8');
  }
  async function exportMenu(chat) {
    return adminMessage({chat_id:chat,text:'خروجی مشتریان و کدهای کمپین را انتخاب کنید:',reply_markup:keyboard([
      [{text:'همه مشتریان',callback_data:'adm:export:all'},{text:'مشتریان فعال',callback_data:'adm:export:active'}],
      [{text:'مشتریان غیرفعال',callback_data:'adm:export:inactive'}],
      [{text:'منوی اصلی',callback_data:'adm:home'}]
    ])});
  }
  async function exportPeriodMenu(chat,status) {
    if(!['all','active','inactive'].includes(status))return adminMessage({chat_id:chat,text:'فیلتر وضعیت خروجی نامعتبر است.'});
    return adminMessage({chat_id:chat,text:'بازه زمانی خروجی را انتخاب کنید:',reply_markup:keyboard([
      [{text:'همه تاریخ‌ها',callback_data:'adm:export-run:'+status+':all'}],
      [{text:'امروز',callback_data:'adm:export-run:'+status+':today'},{text:'۷ روز اخیر',callback_data:'adm:export-run:'+status+':7d'}],
      [{text:'۳۰ روز اخیر',callback_data:'adm:export-run:'+status+':30d'}],
      [{text:'↩️ بازگشت',callback_data:'adm:export'}]
    ])});
  }
  async function campaignReports(chat) {
    const [rows]=await db.execute(`
      SELECT c.id,c.name,c.status,COUNT(DISTINCT ce.id) total_entries,
        COUNT(DISTINCT CASE WHEN ce.status='active' THEN ce.id END) completed_entries,
        COUNT(DISTINCT CASE WHEN ce.status='pending' THEN ce.id END) pending_entries,
        COUNT(DISTINCT CASE WHEN ce.status IN ('inactive','cancelled','disqualified') THEN ce.id END) excluded_entries,
        COUNT(DISTINCT CASE WHEN cc.status='active' THEN cc.id END) active_codes,
        COUNT(DISTINCT CASE WHEN o.status='approved' THEN o.id END) approved_orders
      FROM campaigns c LEFT JOIN campaign_entries ce ON ce.campaign_id=c.id
      LEFT JOIN campaign_codes cc ON cc.campaign_id=c.id AND cc.entry_id=ce.id
      LEFT JOIN payment_orders o ON o.campaign_id=c.id AND o.entry_id=ce.id
      GROUP BY c.id,c.name,c.status ORDER BY c.id DESC LIMIT 20`);
    if(!rows.length)return adminMessage({chat_id:chat,text:'هنوز کمپینی برای گزارش وجود ندارد.',reply_markup:keyboard([[{text:'داشبورد',callback_data:'adm:stats'}]])});
    const body=rows.map(x=>{const n=Number(x.total_entries||0),a=Number(x.completed_entries||0);return '#'+x.id+' '+x.name+' · '+x.status+'\nعضویت فعال: '+a+'/'+n+' ('+(n?Math.round(a*100/n):0)+'٪) · معلق: '+Number(x.pending_entries||0)+'\nکد فعال: '+Number(x.active_codes||0)+' · سفارش تأییدشده: '+Number(x.approved_orders||0);}).join('\n\n');
    return adminMessage({chat_id:chat,text:'📈 گزارش کمپین‌ها\n\n'+body,reply_markup:keyboard([[{text:'↻ تازه‌سازی',callback_data:'adm:reports'}],[{text:'داشبورد',callback_data:'adm:stats'}]])});
  }
  async function supportList(chat,status='open',page=0) {
    if(!['open','answered','closed','all'].includes(status))return adminMessage({chat_id:chat,text:'فیلتر تیکت نامعتبر است.'});
    const p=Math.max(0,Math.min(10000,Number(page)||0));
    const where=status==='all'?'':'WHERE status=?';
    const params=status==='all'?[10,p*10]:[status,10,p*10];
    const [rows]=await db.execute(`SELECT id,telegram_user_id,status,LEFT(message,90) AS preview,created_at FROM customer_support_tickets ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,params);
    const buttons=rows.map(x=>[{text:'#'+x.id+' · '+x.status+' · '+String(x.preview||'').replace(/\s+/g,' '),callback_data:'adm:support-ticket:'+x.id}]);
    buttons.push([{text:'باز',callback_data:'adm:support:open'},{text:'پاسخ‌داده',callback_data:'adm:support:answered'},{text:'بسته',callback_data:'adm:support:closed'}]);
    buttons.push([{text:'همه',callback_data:'adm:support:all'},{text:'منوی اصلی',callback_data:'adm:home'}]);
    if(p>0)buttons.push([{text:'⬅️ قبلی',callback_data:'adm:support-page:'+status+':'+(p-1)}]);
    if(rows.length===10)buttons.push([{text:'بعدی ➡️',callback_data:'adm:support-page:'+status+':'+(p+1)}]);
    return adminMessage({chat_id:chat,text:'💬 تیکت‌های پشتیبانی · '+status+' · صفحه '+(p+1),reply_markup:keyboard(buttons)});
  }
  async function supportDetail(chat,id) {
    if(!/^\d+$/.test(String(id)))return adminMessage({chat_id:chat,text:'شناسه تیکت نامعتبر است.'});
    const [[ticket]]=await db.execute('SELECT id,telegram_user_id,chat_id,business_connection_id,message,status,admin_reply,replied_at,created_at FROM customer_support_tickets WHERE id=? LIMIT 1',[id]);
    if(!ticket)return adminMessage({chat_id:chat,text:'تیکت پیدا نشد.'});
    const buttons=[];
    if(ticket.status!=='closed')buttons.push([{text:'🔒 بستن تیکت',callback_data:'adm:support-close:'+id}]);
    else buttons.push([{text:'↻ بازگشایی تیکت',callback_data:'adm:support-reopen:'+id}]);
    buttons.push([{text:'✍️ راهنمای پاسخ',callback_data:'adm:support-reply-help:'+id},{text:'↩️ فهرست',callback_data:'adm:support'}]);
    return adminMessage({chat_id:chat,text:'💬 تیکت #'+ticket.id+' · '+ticket.status+'\nکاربر: '+ticket.telegram_user_id+'\nثبت: '+ticket.created_at+'\n\nپیام مشتری:\n'+ticket.message+'\n\nآخرین پاسخ مدیر:\n'+(ticket.admin_reply||'هنوز پاسخی ثبت نشده است.')+'\n\nبرای پاسخ: /reply '+ticket.id+' متن پاسخ',reply_markup:keyboard(buttons)});
  }
  async function setSupportStatus(chat,id,status) {
    if(!/^\d+$/.test(String(id))||!['open','closed'].includes(status))return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'});
    const conn=await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[ticket]]=await conn.execute('SELECT id,status FROM customer_support_tickets WHERE id=? FOR UPDATE',[id]);
      if(!ticket)throw new Error('تیکت پیدا نشد.');
      await conn.execute('UPDATE customer_support_tickets SET status=? WHERE id=?',[status,id]);
      await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),status==='closed'?'close_support_ticket':'reopen_support_ticket','support_ticket',String(id),JSON.stringify({from:ticket.status,to:status,source:'telegram'})]);
      await conn.commit();
      return supportDetail(chat,id);
    } catch(e){await conn.rollback();return adminMessage({chat_id:chat,text:'تغییر وضعیت تیکت انجام نشد: '+e.message});}
    finally{conn.release();}
  }
  async function auditLog(chat) {
    const [rows]=await db.query('SELECT action,entity_type,entity_id,created_at FROM admin_audit_log ORDER BY id DESC LIMIT 15');
    const body=rows.length?rows.map((x,i)=>(i+1)+') '+x.action+' · '+x.entity_type+' #'+(x.entity_id||'-')+'\n'+x.created_at).join('\n\n'):'هنوز رخدادی ثبت نشده است.';
    return adminMessage({chat_id:chat,text:'🧾 ۱۵ رخداد اخیر\n\n'+body,reply_markup:keyboard([[{text:'منوی اصلی',callback_data:'adm:home'}]])});
  }
  const cardWizardFields = [
    {key:'label',label:'عنوان کارت',hint:'مثلاً کارت اصلی فروشگاه'},
    {key:'bankName',label:'نام بانک',hint:'مثلاً ملت؛ اگر نمی‌خواهی ثبت شود، - بفرست'},
    {key:'cardNumber',label:'شماره ۱۶ رقمی کارت',hint:'شماره کارت را بدون فاصله یا با فاصله وارد کن'},
    {key:'cardholderName',label:'نام دارنده کارت',hint:'نام و نام خانوادگی صاحب کارت'}
  ];
  function cardWizardPrompt(state) {
    const f=cardWizardFields[state.step];
    return '💳 '+(state.editingId?'ویرایش کارت':'افزودن کارت')+' · مرحله '+(state.step+1)+' از '+cardWizardFields.length+'\n\n'+f.label+'\n'+f.hint+'\n\nپاسخ را ارسال کن.';
  }
  function cardWizardMarkup() {
    return keyboard([[{text:'⬅️ بازگشت',callback_data:'adm:card-wizard-back'},{text:'✖️ انصراف',callback_data:'adm:card-wizard-cancel'}]]);
  }
  async function cardWizardReview(chat,state) {
    const v=state.values, cardDigits=digits(v.cardNumber);
    const body='عنوان: '+v.label+'\nبانک: '+(v.bankName||'-')+'\nشماره کارت: •••• •••• •••• '+cardDigits.slice(-4)+'\nدارنده: '+v.cardholderName;
    const buttons=cardWizardFields.map((f,i)=>[{text:'✏️ '+(i+1)+'. '+f.label,callback_data:'adm:card-wizard-edit:'+i}]);
    buttons.push([{text:'✅ تأیید و ذخیره',callback_data:'adm:card-wizard-save'},{text:'❌ لغو',callback_data:'adm:card-wizard-cancel'}]);
    return adminMessage({chat_id:chat,text:'🔎 بازبینی اطلاعات کارت\n\n'+body+'\n\n'+(state.editingId?'برای ذخیره تغییرات تأیید کن.':'برای ثبت کارت تأیید کن.'),reply_markup:keyboard(buttons)});
  }
  async function cardList(chat) {
    const rows=await bankCardService.listCards();
    const buttons=rows.map(c=>[{text:(c.status==='active'?'🟢 ':'⚪ ')+c.label+' · '+c.last4,callback_data:'adm:card:'+c.id}]);
    buttons.push([{text:'➕ افزودن کارت',callback_data:'adm:card-add'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    return adminMessage({chat_id:chat,text:rows.length?'💳 کارت‌های ثبت‌شده\nبرای مدیریت یک کارت را انتخاب کنید.':'هنوز کارتی ثبت نشده است.',reply_markup:keyboard(buttons)});
  }
  async function cardDetail(chat,id) {
    if(!/^\d+$/.test(String(id)))return adminMessage({chat_id:chat,text:'شناسه کارت نامعتبر است.'});
    const c=await bankCardService.getCard(Number(id));
    return adminMessage({chat_id:chat,text:'💳 '+c.label+'\nبانک: '+(c.bank_name||'-')+'\nشماره کارت: '+c.card_number+'\nدارنده: '+c.cardholder_name+'\nوضعیت: '+c.status,reply_markup:keyboard([[{text:'✏️ ویرایش کارت',callback_data:'adm:card-edit:'+id}],[{text:c.status==='active'?'⏸ غیرفعال‌سازی':'✅ فعال‌سازی',callback_data:'adm:card-status:'+id+':'+(c.status==='active'?'inactive':'active')}],[{text:'🗑 حذف کارت',callback_data:'adm:card-delete:'+id}],[{text:'↩️ فهرست کارت‌ها',callback_data:'adm:cards'}]])});
  }
  async function campaignCardPicker(chat,campaignId) {
    const cards=await bankCardService.listCards({includeInactive:false});
    if(!cards.length)return adminMessage({chat_id:chat,text:'ابتدا یک کارت فعال اضافه کنید.',reply_markup:keyboard([[{text:'مدیریت کارت‌ها',callback_data:'adm:cards'}],[{text:'بازگشت',callback_data:'adm:campaign-detail:'+campaignId}]])});
    const suggestion=await bankCardService.suggestCard();
    const rows=[];
    if(suggestion)rows.push([{text:'⭐ پیشنهاد سیستم: '+suggestion.label+' · '+suggestion.last4+' ('+suggestion.recent_deliveries+' ارسال در ۷ روز)',callback_data:'adm:campaign-card-confirm:'+campaignId+':'+suggestion.id}]);
    rows.push(...cards.filter(c=>!suggestion||c.id!==suggestion.id).map(c=>[{text:c.label+' · '+c.last4,callback_data:'adm:campaign-card-confirm:'+campaignId+':'+c.id}]));
    rows.push([{text:'لغو',callback_data:'adm:campaign-detail:'+campaignId}]);
    return adminMessage({chat_id:chat,text:'کارت مقصد را انتخاب کنید. پیشنهاد بر اساس کمترین تعداد ارسال در ۷ روز اخیر است؛ موجودی حساب بررسی نمی‌شود و تصمیم نهایی با شماست.',reply_markup:keyboard(rows)});
  }
  async function campaignList(chat, page = 0, status = 'all') {
    if (!campaignService) return adminMessage({chat_id:chat,text:'سرویس کمپین پیکربندی نشده است.'});
    const p=Math.max(0,Math.min(10000,Number(page)||0));
    const allowed=['all','draft','scheduled','open','paused','closed','drawn','archived'];
    if(!allowed.includes(status))return adminMessage({chat_id:chat,text:'فیلتر وضعیت کمپین نامعتبر است.'});
    const where=status==='all'?'':'WHERE c.status=?';
    const params=status==='all'?[]:[status];
    const [rows]=await db.execute(`SELECT c.id,c.name,c.slug,c.status,c.payment_mode,
      (SELECT COUNT(*) FROM campaign_entries e WHERE e.campaign_id=c.id AND e.status='active') participants,
      (SELECT COUNT(*) FROM campaign_codes k WHERE k.campaign_id=c.id AND k.status='active') codes
      FROM campaigns c ${where} ORDER BY c.id DESC LIMIT 10 OFFSET ?`,[...params,p*10]);
    const buttons=rows.map(x=>[{text:'#'+x.id+' '+String(x.name).slice(0,22)+' · '+x.status,callback_data:'adm:campaign-detail:'+x.id}]);
    const nav=[];if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'adm:campaigns:'+status+':'+(p-1)});if(rows.length===10)nav.push({text:'بعدی ➡️',callback_data:'adm:campaigns:'+status+':'+(p+1)});if(nav.length)buttons.push(nav);
    buttons.push([{text:'فیلتر: '+status,callback_data:'adm:campaign-filter'}],[{text:'➕ ساخت کمپین',callback_data:'adm:campaign-create'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    const body=rows.length?rows.map(x=>'#'+x.id+' '+x.name+' | '+x.slug+'\nوضعیت: '+x.status+' | افراد: '+x.participants+' | کدها: '+x.codes+' | '+x.payment_mode).join('\n\n'):'کمپینی با این فیلتر پیدا نشد.';
    return adminMessage({chat_id:chat,text:'🧩 مدیریت کمپین‌ها · صفحه '+(p+1)+' · '+status+'\n\n'+body,reply_markup:keyboard(buttons)});
  }
  async function campaignFilter(chat) {
    const states=['all','draft','scheduled','open','paused','closed','drawn','archived'];
    const labels={all:'همه',draft:'پیش‌نویس',scheduled:'زمان‌بندی‌شده',open:'باز',paused:'متوقف',closed:'بسته',drawn:'قرعه‌کشی‌شده',archived:'آرشیو'};
    const rows=states.map(x=>[{text:labels[x],callback_data:'adm:campaigns:'+x+':0'}]);
    rows.push([{text:'↩️ بازگشت',callback_data:'adm:campaigns'}]);
    return adminMessage({chat_id:chat,text:'وضعیت کمپین را فیلتر کنید:',reply_markup:keyboard(rows)});
  }
  async function campaignDetail(chat,id) {
    if(!/^\d+$/.test(String(id)))return adminMessage({chat_id:chat,text:'شناسه نامعتبر است.'});
    const [[c]]=await db.execute('SELECT * FROM campaigns WHERE id=? LIMIT 1',[id]);
    if(!c)return adminMessage({chat_id:chat,text:'کمپین پیدا نشد.'});
    const [[n]]=await db.execute("SELECT (SELECT COUNT(*) FROM campaign_entries WHERE campaign_id=? AND status='active') participants,(SELECT COUNT(*) FROM campaign_codes WHERE campaign_id=? AND status='active') codes,(SELECT COUNT(*) FROM payment_orders WHERE campaign_id=? AND status IN ('pending_payment','receipt_submitted')) pending_orders",[id,id,id]);
    const next={draft:['open'],scheduled:['open','closed'],open:['paused','closed'],paused:['open','closed'],closed:[],drawn:['archived'],archived:[]};
    const buttons=(next[c.status]||[]).map(s=>[{text:({open:'🟢 بازکردن',paused:'⏸ توقف',closed:'🔒 بستن',archived:'📦 آرشیو'}[s]),callback_data:'adm:campaign-confirm:'+id+':'+s}]);
    if(c.status==='draft') buttons.push([{text:'✏️ ویرایش پیش‌نویس',callback_data:'adm:campaign-edit:'+id}]);
    if(c.payment_mode==='manual') buttons.push([{text:'💳 تغییر کارت مقصد',callback_data:'adm:campaign-card:'+id}]);
    if(c.payment_mode==='manual') buttons.push([{text:'🕘 تاریخچه تغییر کارت',callback_data:'adm:campaign-card-history:'+id}]);
    let campaignCardInfo='';
    if(c.payment_mode==='manual'){const [[pc]]=await db.execute('SELECT label,RIGHT(card_number,4) last4,status FROM bank_cards WHERE id=? LIMIT 1',[c.current_payment_card_id]);campaignCardInfo='\nکارت مقصد: '+(pc?pc.label+' · '+pc.last4+' · '+pc.status:'تعیین نشده');}
    buttons.push([{text:'↩️ فهرست کمپین‌ها',callback_data:'adm:campaigns'}]);
    return adminMessage({chat_id:chat,text:'🧩 '+c.name+'\nشناسه: '+c.id+' · '+c.slug+'\nوضعیت: '+c.status+'\nپرداخت: '+c.payment_mode+' · قیمت: '+c.price_per_code+' '+c.currency+campaignCardInfo+'\nظرفیت افراد: '+(c.max_participants??'نامحدود')+' · سقف کد: '+(c.max_codes??'نامحدود')+'\nسقف هر نفر: '+c.max_codes_per_participant+'\nافراد فعال: '+n.participants+' · کد فعال: '+n.codes+' · سفارش منتظر: '+n.pending_orders+'\nقرعه‌کشی: '+c.draw_method+' / '+c.draw_basis+'\nبرندگان: '+c.winner_count+' · ذخیره: '+c.alternate_count,reply_markup:keyboard(buttons)});
  }
  const campaignWizardFields = [
    {key:'name',label:'نام کمپین',hint:'مثلاً کمپین پاییز ۱۴۰۵'},
    {key:'slug',label:'شناسه انگلیسی (slug)',hint:'فقط حروف انگلیسی کوچک، عدد و خط تیره؛ مثل autumn-1405'},
    {key:'payment_mode',label:'نوع پرداخت',hint:'free یا manual'},
    {key:'price_per_code',label:'مبلغ هر کد',hint:'عدد صحیح به ریال؛ برای free عدد 0'},
    {key:'max_participants',label:'سقف شرکت‌کنندگان',hint:'عدد یا - برای نامحدود'},
    {key:'max_codes',label:'سقف کل کدها',hint:'عدد یا - برای نامحدود'},
    {key:'max_codes_per_participant',label:'سقف کد هر نفر',hint:'عدد صحیح؛ حداقل 1'},
    {key:'winner_count',label:'تعداد برندگان اصلی',hint:'عدد صحیح؛ حداقل 1'},
    {key:'alternate_count',label:'تعداد برندگان ذخیره',hint:'عدد صحیح؛ می‌تواند 0 باشد'},
    {key:'draw_method',label:'روش قرعه‌کشی',hint:'system یا live_wheel یا hybrid'},
    {key:'draw_basis',label:'مبنای انتخاب برنده',hint:'per_code یا per_participant'},
    {key:'payment_card_id',label:'شناسه کارت بانکی',hint:'برای manual شناسه کارت فعال؛ برای free مقدار -'}
  ];
  function campaignWizardValue(state,key) { return state.values[key] == null ? '-' : String(state.values[key]); }
  function campaignWizardPrompt(state) {
    const f=campaignWizardFields[state.step];
    const choiceFields=['payment_mode','draw_method','draw_basis','payment_card_id'];
    return '🧩 ساخت کمپین · مرحله '+(state.step+1)+' از '+campaignWizardFields.length+'\n\n'+f.label+
      (choiceFields.includes(f.key)?'':'\n'+f.hint)+
      (state.editingId?'\nویرایش پیش‌نویس #'+state.editingId:'')+
      (choiceFields.includes(f.key)?'\n\nاز دکمه‌های زیر انتخاب کن.':'\n\nپاسخ را ارسال کن.');
  }
  function campaignWizardMarkup(state) {
    const key=campaignWizardFields[state.step].key;
    if(key==='payment_mode') return keyboard([
      [{text:'🆓 رایگان',callback_data:'adm:campaign-wizard-payment:free'},{text:'💳 پولی',callback_data:'adm:campaign-wizard-payment:manual'}],
      [{text:'⬅️ بازگشت',callback_data:'adm:campaign-wizard-back'},{text:'✖️ انصراف',callback_data:'adm:campaign-wizard-cancel'}]
    ]);
    if(key==='draw_method') return keyboard([
      [{text:'🎡 از گردونه',callback_data:'adm:campaign-wizard-draw-method:live_wheel'},{text:'🤖 از خود ربات',callback_data:'adm:campaign-wizard-draw-method:system'}],
      [{text:'⬅️ بازگشت',callback_data:'adm:campaign-wizard-back'},{text:'✖️ انصراف',callback_data:'adm:campaign-wizard-cancel'}]
    ]);
    if(key==='draw_basis') return keyboard([
      [{text:'🎟 به ازای هر کد',callback_data:'adm:campaign-wizard-draw-basis:per_code'},{text:'👤 به ازای هر شرکت‌کننده',callback_data:'adm:campaign-wizard-draw-basis:per_participant'}],
      [{text:'⬅️ بازگشت',callback_data:'adm:campaign-wizard-back'},{text:'✖️ انصراف',callback_data:'adm:campaign-wizard-cancel'}]
    ]);
    if(key==='payment_card_id') {
      const cards=state.cards||[];
      const rows=cards.map(c=>[{text:'💳 کارت #'+c.id+' · '+c.label+' · '+c.last4,callback_data:'adm:campaign-wizard-card:'+c.id}]);
      if(!rows.length) rows.push([{text:'➕ افزودن کارت بانکی',callback_data:'adm:cards'}]);
      rows.push([{text:'⬅️ بازگشت',callback_data:'adm:campaign-wizard-back'},{text:'✖️ انصراف',callback_data:'adm:campaign-wizard-cancel'}]);
      return keyboard(rows);
    }
    return keyboard([[{text:'⬅️ بازگشت',callback_data:'adm:campaign-wizard-back'},{text:'✖️ انصراف',callback_data:'adm:campaign-wizard-cancel'}]]);
  }
  async function createCampaignPrompt(chat) {
    const cards=bankCardService?await bankCardService.listCards({includeInactive:false}):[];
    const cardHint=cards.length?'\nکارت‌های فعال: '+cards.map(c=>c.id+' = '+c.label+' · '+c.last4).join(' | '):'\nهنوز کارت فعالی ثبت نشده است؛ برای پرداخت دستی ابتدا کارت اضافه کن.';
    const state={type:'campaign-wizard',step:0,values:{payment_mode:'free',price_per_code:'0',max_participants:'-',max_codes:'-',max_codes_per_participant:'1',winner_count:'1',alternate_count:'0',draw_method:'system',draw_basis:'per_code',payment_card_id:'-'},cards,expires:Date.now()+1800000};
    pending.set(String(adminId),state);
    return adminMessage({chat_id:chat,text:campaignWizardPrompt(state),reply_markup:campaignWizardMarkup(state)});
  }
  async function editDraftCampaign(chat,id) {
    if(!/^\d+$/.test(String(id))) return adminMessage({chat_id:chat,text:'شناسه کمپین نامعتبر است.'});
    const [[c]]=await db.execute("SELECT * FROM campaigns WHERE id=? AND status='draft' LIMIT 1",[id]);
    if(!c)return adminMessage({chat_id:chat,text:'فقط کمپین پیش‌نویس قابل ویرایش است.'});
    const values={name:c.name,slug:c.slug,payment_mode:c.payment_mode,price_per_code:String(c.price_per_code),max_participants:c.max_participants==null?'-':String(c.max_participants),max_codes:c.max_codes==null?'-':String(c.max_codes),max_codes_per_participant:String(c.max_codes_per_participant),winner_count:String(c.winner_count),alternate_count:String(c.alternate_count),draw_method:c.draw_method,draw_basis:c.draw_basis,payment_card_id:c.current_payment_card_id==null?'-':String(c.current_payment_card_id)};
    const cards=bankCardService?await bankCardService.listCards({includeInactive:false}):[];
    const state={type:'campaign-wizard',step:0,values,cards,editingId:String(id),expires:Date.now()+1800000};
    pending.set(String(adminId),state);
    return adminMessage({chat_id:chat,text:'✏️ ویرایش پیش‌نویس کمپین #'+id+'\nمقادیر فعلی بارگذاری شدند. مرحله‌به‌مرحله جلو برو؛ در پایان امکان بازبینی و اصلاح هر فیلد را داری.\n\n'+campaignWizardPrompt(state),reply_markup:campaignWizardMarkup(state)});
  }
  async function campaignWizardReview(chat,state) {
    const v=state.values;
    const body=campaignWizardFields.map((f,i)=>(i+1)+'. '+f.label+': '+campaignWizardValue(state,f.key)).join('\n');
    const buttons=campaignWizardFields.map((f,i)=>({f,i})).filter(({f})=>!(v.payment_mode==='free'&&f.key==='payment_card_id')).map(({f,i})=>[{text:'✏️ '+(i+1)+'. '+f.label,callback_data:'adm:campaign-wizard-edit:'+i}]);
    buttons.push([{text:state.editingId?'💾 ذخیره ویرایش پیش‌نویس':'✅ ساخت پیش‌نویس',callback_data:'adm:campaign-wizard-save'},{text:'❌ لغو',callback_data:'adm:campaign-wizard-cancel'}]);
    return adminMessage({chat_id:chat,text:'🔎 بازبینی اطلاعات کمپین\n\n'+body+'\n\nبرای اصلاح هر مورد، دکمه همان مورد را بزن.',reply_markup:keyboard(buttons)});
  }
  async function orderList(chat, page = 0, status = 'action') {
    const p=Math.max(0,Math.min(10000,Number(page)||0));
    const states=['action','all','pending_payment','receipt_submitted','approved','rejected','expired','cancelled'];
    if(!states.includes(status))return adminMessage({chat_id:chat,text:'فیلتر سفارش نامعتبر است.'});
    const where=status==='action'?"WHERE o.status IN ('pending_payment','receipt_submitted')":status==='all'?'':'WHERE o.status=?';
    const params=status==='action'||status==='all'?[]:[status];
    const [rows]=await db.execute(`SELECT o.id,o.order_ref,o.total_snapshot,o.currency,o.status,o.created_at,c.name campaign_name,p.full_name
      FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id JOIN participants p ON p.id=o.participant_id
      ${where} ORDER BY o.created_at DESC LIMIT 10 OFFSET ?`,[...params,p*10]);
    const buttons=rows.map(o=>[{text:'#'+o.id+' '+String(o.full_name).slice(0,18)+' · '+o.status,callback_data:'adm:order:'+o.id}]);
    const nav=[];if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'adm:orders:'+status+':'+(p-1)});if(rows.length===10)nav.push({text:'بعدی ➡️',callback_data:'adm:orders:'+status+':'+(p+1)});if(nav.length)buttons.push(nav);
    buttons.push([{text:'فیلتر وضعیت',callback_data:'adm:order-filter'}],[{text:'↻ تازه‌سازی',callback_data:'adm:orders:'+status+':'+p}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    const body=rows.length?rows.map(o=>'#'+o.id+' '+o.order_ref+' | '+o.campaign_name+'\n'+o.full_name+' | '+o.total_snapshot+' '+o.currency+' | '+o.status).join('\n\n'):'سفارشی با این فیلتر پیدا نشد.';
    return adminMessage({chat_id:chat,text:'💳 سفارش‌ها · صفحه '+(p+1)+' · '+status+'\n\n'+body,reply_markup:keyboard(buttons)});
  }
  async function orderFilter(chat) {
    const states=[['action','نیازمند اقدام'],['all','همه'],['pending_payment','منتظر پرداخت'],['receipt_submitted','رسید ارسال‌شده'],['approved','تأییدشده'],['rejected','ردشده'],['expired','منقضی'],['cancelled','لغوشده']];
    const rows=states.map(([v,l])=>[{text:l,callback_data:'adm:orders:'+v+':0'}]);
    rows.push([{text:'↩️ بازگشت',callback_data:'adm:orders'}]);
    return adminMessage({chat_id:chat,text:'وضعیت سفارش‌ها را انتخاب کنید:',reply_markup:keyboard(rows)});
  }
  async function orderDetail(chat,id) {
    if(!/^\d+$/.test(String(id)))return adminMessage({chat_id:chat,text:'شناسه سفارش نامعتبر است.'});
    const [[o]]=await db.execute('SELECT o.*,c.name campaign_name,p.full_name,p.phone,p.instagram,p.chat_id,p.business_connection_id FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id JOIN participants p ON p.id=o.participant_id WHERE o.id=? LIMIT 1',[id]);
    if(!o)return adminMessage({chat_id:chat,text:'سفارش پیدا نشد.'});
    const [receipts]=await db.execute('SELECT id,telegram_file_id,declared_tracking_ref,submitted_at,review_status FROM payment_receipts WHERE order_id=? ORDER BY id DESC LIMIT 3',[id]);
    const delivered=bankCardService?await bankCardService.deliveries(id):[];
    const cardHistory=delivered.length?'\nکارت‌های ارسال‌شده: '+delivered.map(d=>d.card_label_snapshot+' · '+d.last4+' · '+d.sent_at).join('؛ '):'';
    const textBody='💳 سفارش #'+o.id+'\nمرجع: '+o.order_ref+'\nکمپین: '+o.campaign_name+'\nشرکت‌کننده: '+o.full_name+'\nموبایل: '+o.phone+'\nاینستاگرام: @'+o.instagram+'\nتعداد کد: '+o.quantity+'\nمبلغ: '+o.total_snapshot+' '+o.currency+'\nوضعیت: '+o.status+'\nانقضا: '+o.expires_at+'\nرسیدها: '+receipts.length+cardHistory;
    const orderButtons=[];
    if(o.status==='pending_payment')orderButtons.push([{text:'📨 ارسال دوباره اطلاعات پرداخت',callback_data:'adm:order-resend:'+id}]);
    if(o.status==='receipt_submitted')orderButtons.push([{text:'✅ تأیید پرداخت',callback_data:'adm:order-confirm:'+id+':approve'},{text:'❌ رد پرداخت',callback_data:'adm:order-confirm:'+id+':reject'}]);
    orderButtons.push([{text:'↩️ سفارش‌ها',callback_data:'adm:orders'}]);
    await adminMessage({chat_id:chat,text:textBody,reply_markup:keyboard(orderButtons)});
    for(const r of receipts) await tg('sendPhoto',{chat_id:chat,photo:r.telegram_file_id,caption:'رسید سفارش #'+id+' · '+r.submitted_at+' · '+(r.declared_tracking_ref||'بدون شماره پیگیری')});
  }
  async function profileRequestList(chat) {
    const [rows]=await db.query("SELECT r.id,r.field_name,r.old_value,r.requested_value,r.created_at,p.full_name FROM profile_change_requests r JOIN participants p ON p.id=r.participant_id WHERE r.status='pending' ORDER BY r.created_at ASC LIMIT 20");
    const buttons=rows.map(r=>[{text:'#'+r.id+' '+r.full_name+' · '+r.field_name,callback_data:'adm:profile-request:'+r.id}]);
    buttons.push([{text:'↻ تازه‌سازی',callback_data:'adm:profile-requests'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    const body=rows.length?rows.map(r=>'#'+r.id+' '+r.full_name+'\n'+r.field_name+': '+r.old_value+' ← '+r.requested_value).join('\n\n'):'درخواست اصلاح معلقی وجود ندارد.';
    return adminMessage({chat_id:chat,text:'📝 درخواست‌های اصلاح پروفایل\n\n'+body,reply_markup:keyboard(buttons)});
  }
  async function profileRequestDetail(chat,id) {
    if(!/^\d+$/.test(String(id)))return adminMessage({chat_id:chat,text:'شناسه درخواست نامعتبر است.'});
    const [[r]]=await db.execute("SELECT r.*,p.full_name FROM profile_change_requests r JOIN participants p ON p.id=r.participant_id WHERE r.id=? LIMIT 1",[id]);
    if(!r)return adminMessage({chat_id:chat,text:'درخواست پیدا نشد.'});
    return adminMessage({chat_id:chat,text:'درخواست اصلاح #'+r.id+'\nشرکت‌کننده: '+r.full_name+'\nفیلد: '+r.field_name+'\nمقدار فعلی: '+r.old_value+'\nمقدار درخواستی: '+r.requested_value+'\nوضعیت: '+r.status,reply_markup:keyboard(r.status==='pending'?[[{text:'✅ تأیید',callback_data:'adm:profile-confirm:'+id+':approve'},{text:'❌ رد',callback_data:'adm:profile-confirm:'+id+':reject'}],[{text:'↩️ فهرست',callback_data:'adm:profile-requests'}]]:[[ {text:'↩️ فهرست',callback_data:'adm:profile-requests'} ]])});
  }
  async function processCallback(q) {
    if (!isAdmin(q) || !String(q.data||'').startsWith('adm:')) return false;
    const chat = q.message.chat.id, data = q.data;
    if (q.message.message_id) uiMessageIds.set(String(chat), q.message.message_id);
    await tg('answerCallbackQuery',{callback_query_id:q.id});
    if(data==='adm:cards')return cardList(chat);
    if(data==='adm:card-add'){const state={type:'card-wizard',step:0,values:{label:'',bankName:'',cardNumber:'',cardholderName:''},expires:Date.now()+1800000};pending.set(String(adminId),state);return adminMessage({chat_id:chat,text:cardWizardPrompt(state),reply_markup:cardWizardMarkup()});}
    if(data.startsWith('adm:card-wizard-edit:')){const p=pending.get(String(adminId));const n=Number(data.slice('adm:card-wizard-edit:'.length));if(!p||p.type!=='card-wizard'||!Number.isInteger(n)||n<0||n>=cardWizardFields.length)return adminMessage({chat_id:chat,text:'فرم کارت منقضی شده است.'});p.step=n;p.reviewEdit=true;p.expires=Date.now()+1800000;return adminMessage({chat_id:chat,text:'✏️ اصلاح '+cardWizardFields[n].label+'\nمقدار فعلی: '+(n===2?'•••• '+digits(p.values.cardNumber).slice(-4):p.values[cardWizardFields[n].key]||'-')+'\nمقدار جدید را بفرست.',reply_markup:cardWizardMarkup()});}
    if(data==='adm:card-wizard-back'){const p=pending.get(String(adminId));if(!p||p.type!=='card-wizard')return adminMessage({chat_id:chat,text:'فرم کارت منقضی شده است.'});p.step=Math.max(0,p.step-1);p.reviewEdit=false;p.expires=Date.now()+1800000;return adminMessage({chat_id:chat,text:cardWizardPrompt(p),reply_markup:cardWizardMarkup()});}
    if(data==='adm:card-wizard-cancel'){pending.delete(String(adminId));return cardList(chat);}
    if(data==='adm:card-wizard-save'){const p=pending.get(String(adminId));if(!p||p.type!=='card-wizard'||p.expires<Date.now())return adminMessage({chat_id:chat,text:'فرم کارت منقضی شده است؛ دوباره شروع کن.'});try{const v=p.values;let result;if(p.editingId){await bankCardService.updateCard({id:Number(p.editingId),label:v.label,bankName:v.bankName||null,cardNumber:digits(v.cardNumber),cardholderName:v.cardholderName});result={id:Number(p.editingId)};}else{result=await bankCardService.addCard({label:v.label,bankName:v.bankName||null,cardNumber:digits(v.cardNumber),cardholderName:v.cardholderName});}pending.delete(String(adminId));await audit(p.editingId?'edit_bank_card':'add_bank_card','bank_card',result.id,{last4:digits(v.cardNumber).slice(-4),source:'telegram'});return cardDetail(chat,result.id);}catch(e){return adminMessage({chat_id:chat,text:'ذخیره کارت انجام نشد: '+e.message+'\nاطلاعات فرم حفظ شده است.'});}}
    if(data.startsWith('adm:card:'))return cardDetail(chat,data.slice('adm:card:'.length));
    if(data.startsWith('adm:card-edit:')){const id=data.slice('adm:card-edit:'.length);if(!/^\d+$/.test(id))return adminMessage({chat_id:chat,text:'شناسه کارت نامعتبر است.'});const c=await bankCardService.getCard(Number(id));const state={type:'card-wizard',editingId:id,step:0,values:{label:c.label,bankName:c.bank_name||'',cardNumber:c.card_number,cardholderName:c.cardholder_name},expires:Date.now()+1800000};pending.set(String(adminId),state);return adminMessage({chat_id:chat,text:cardWizardPrompt(state),reply_markup:cardWizardMarkup()});}
    if(data.startsWith('adm:card-delete:')){const id=data.slice('adm:card-delete:'.length);if(!/^\d+$/.test(id))return adminMessage({chat_id:chat,text:'شناسه کارت نامعتبر است.'});const card=await bankCardService.getCard(Number(id));pending.set(String(adminId),{type:'card-delete',id,expires:Date.now()+60000});return adminMessage({chat_id:chat,text:'⚠️ حذف دائمی کارت «'+card.label+' · '+card.card_number.slice(-4)+'» را تأیید می‌کنی؟\nاگر کارت در کمپین، تاریخچه یا سفارش استفاده شده باشد، حذف انجام نمی‌شود.',reply_markup:keyboard([[{text:'🗑 بله، حذف شود',callback_data:'adm:card-delete-apply:'+id},{text:'انصراف',callback_data:'adm:card:'+id}]])});}
    if(data.startsWith('adm:card-delete-apply:')){const id=data.slice('adm:card-delete-apply:'.length),p=pending.get(String(adminId));pending.delete(String(adminId));if(!/^\d+$/.test(id)||!p||p.type!=='card-delete'||p.id!==id||p.expires<Date.now())return adminMessage({chat_id:chat,text:'درخواست حذف منقضی یا نامعتبر است.'});try{await bankCardService.deleteCard(Number(id));await audit('delete_bank_card','bank_card',id,{source:'telegram'});return cardList(chat);}catch(e){return adminMessage({chat_id:chat,text:'حذف کارت انجام نشد: '+e.message,reply_markup:keyboard([[{text:'↩️ بازگشت به کارت',callback_data:'adm:card:'+id}],[{text:'فهرست کارت‌ها',callback_data:'adm:cards'}]])});}}
    if(data.startsWith('adm:card-status:')){const [, ,id,status]=data.split(':');if(!/^\d+$/.test(id)||!['active','inactive'].includes(status))return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'});pending.set(String(adminId),{type:'card-status',id,status,expires:Date.now()+60000});return adminMessage({chat_id:chat,text:'تغییر وضعیت کارت را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید',callback_data:'adm:card-status-apply:'+id+':'+status},{text:'لغو',callback_data:'adm:card:'+id}]])});}
    if(data.startsWith('adm:card-status-apply:')){const [, ,id,status]=data.split(':');const p=pending.get(String(adminId));pending.delete(String(adminId));if(!p||p.type!=='card-status'||p.id!==id||p.status!==status||p.expires<Date.now())return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'});await bankCardService.setCardStatus(Number(id),status);await audit(status==='active'?'activate_bank_card':'deactivate_bank_card','bank_card',id,{source:'telegram'});return cardDetail(chat,id);}
    if(data.startsWith('adm:campaign-card-history:')){const id=data.slice('adm:campaign-card-history:'.length);if(!/^\d+$/.test(id))return adminMessage({chat_id:chat,text:'شناسه کمپین نامعتبر است.'});const rows=await bankCardService.campaignHistory(Number(id));const body=rows.length?rows.map(r=>r.label+' · '+r.last4+'\nمدیر: '+r.changed_by+' · '+r.created_at+'\n'+(r.change_reason||'بدون توضیح')).join('\n\n'):'تاریخچه‌ای برای این کمپین ثبت نشده است.';return adminMessage({chat_id:chat,text:'🕘 تاریخچه کارت کمپین #'+id+'\n\n'+body,reply_markup:keyboard([[{text:'↩️ بازگشت به کمپین',callback_data:'adm:campaign-detail:'+id}]])});}
    if(data.startsWith('adm:campaign-card:'))return campaignCardPicker(chat,data.slice('adm:campaign-card:'.length));
    if(data.startsWith('adm:campaign-card-confirm:')){const [, ,campaignId,cardId]=data.split(':');if(!/^\d+$/.test(campaignId)||!/^\d+$/.test(cardId))return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'});pending.set(String(adminId),{type:'campaign-card',campaignId,cardId,expires:Date.now()+60000});const card=await bankCardService.getCard(Number(cardId),{activeOnly:true});return adminMessage({chat_id:chat,text:'تغییر کارت کمپین به «'+card.label+' · '+card.card_number.slice(-4)+'» را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید تغییر',callback_data:'adm:campaign-card-apply:'+campaignId+':'+cardId},{text:'لغو',callback_data:'adm:campaign-detail:'+campaignId}]])});}
    if(data.startsWith('adm:campaign-card-apply:')){const [, ,campaignId,cardId]=data.split(':');const p=pending.get(String(adminId));pending.delete(String(adminId));if(!p||p.type!=='campaign-card'||p.campaignId!==campaignId||p.cardId!==cardId||p.expires<Date.now())return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'});await bankCardService.assignCampaignCard(Number(campaignId),Number(cardId),'changed via Telegram admin panel');return campaignDetail(chat,campaignId);}
    if (data==='adm:home') return home(chat);
    if (data==='adm:participants') return participantList(chat,0);
    if (data.startsWith('adm:participants:')) return participantList(chat,data.split(':')[2]);
    if (data.startsWith('adm:participant:')) return participantDetail(chat,data.slice('adm:participant:'.length));
    if (data.startsWith('adm:participant-status:')) {
      const [, , id, status]=data.split(':');
      if(!/^\d+$/.test(id)||!['active','inactive'].includes(status))return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'});
      const conn=await db.getConnection();
      try {
        await conn.beginTransaction();
        const [[current]]=await conn.execute('SELECT id,status FROM participants WHERE id=? FOR UPDATE',[id]);
        if(!current)throw new Error('مشتری پیدا نشد.');
        if(current.status===status)throw new Error('وضعیت از قبل همین مقدار است.');
        await conn.execute('UPDATE participants SET status=? WHERE id=?',[status,id]);
        await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),status==='active'?'activate_participant':'deactivate_participant','participant',id,JSON.stringify({from:current.status,to:status,source:'telegram'})]);
        await conn.commit();
        return participantDetail(chat,id);
      } catch(e) { await conn.rollback();return adminMessage({chat_id:chat,text:'تغییر وضعیت انجام نشد: '+e.message}); }
      finally { conn.release(); }
    }
    if (data==='adm:draws') return campaignDrawList(chat);
    if (data.startsWith('adm:draw-campaign:')) return campaignDrawAction(chat,data.slice('adm:draw-campaign:'.length));
    if (data.startsWith('adm:draw-prepare:')) return prepareCampaignDraw(chat,data.slice('adm:draw-prepare:'.length));
    if (data.startsWith('adm:draw-run:')) return resumeCampaignDraw(chat,data.slice('adm:draw-run:'.length));
    if (data.startsWith('adm:draw-live:')) { const [, , id, page='0']=data.split(':'); return liveWheelCandidatePage(chat,id,page); }
    if (data.startsWith('adm:draw-live-start:')) return startLiveWheelResult(chat,data.slice('adm:draw-live-start:'.length));
    if (data==='adm:draw-live-cancel') { pending.delete(String(adminId)); return adminMessage({chat_id:chat,text:'ثبت نتیجه لغو شد.'}); }
    if (data.startsWith('adm:draw-approve:')) return approveCampaignDraw(chat,data.slice('adm:draw-approve:'.length));
    if (data.startsWith('adm:draw-view:')) {
      const id=data.slice('adm:draw-view:'.length);
      const [[d]]=await db.execute('SELECT id,campaign_id,draw_number,status,method,snapshot_hash,winner_count,alternate_count FROM campaign_draws WHERE id=? LIMIT 1',[id]);
      if(!d)return adminMessage({chat_id:chat,text:'قرعه‌کشی پیدا نشد.'});
      const [winners]=await db.execute('SELECT winner_rank,winner_type,participant_id,code,selection_method FROM draw_winners WHERE draw_id=? ORDER BY winner_rank',[id]);
      const body=winners.length?winners.map(w=>'رتبه '+w.winner_rank+' · '+w.winner_type+' · مشتری #'+w.participant_id+' · '+(w.code||'بدون کد')).join('\n'):'نتیجه هنوز انتخاب نشده است.';
      return adminMessage({chat_id:chat,text:'قرعه‌کشی #'+d.draw_number+' · '+d.status+'\nSnapshot: '+(d.snapshot_hash||'-')+'\n\n'+body,reply_markup:keyboard(d.status==='pending_approval'?[[{text:'تأیید نتیجه',callback_data:'adm:draw-approve:'+id}],[{text:'بازگشت',callback_data:'adm:draw-campaign:'+d.campaign_id}]]:[[ {text:'بازگشت',callback_data:'adm:draw-campaign:'+d.campaign_id}]])});
    }
    if (data==='adm:stats') return stats(chat);
    if (data==='adm:reports') return campaignReports(chat);
    if (data==='adm:campaigns') return campaignList(chat);
    if (data==='adm:campaign-filter') return campaignFilter(chat);
    if (data.startsWith('adm:campaigns:')) { const [, , status='all', page='0']=data.split(':'); return campaignList(chat,page,status); }
    if (data==='adm:orders') return orderList(chat);
    if (data==='adm:order-filter') return orderFilter(chat);
    if (data.startsWith('adm:orders:')) { const [, , status='action', page='0']=data.split(':'); return orderList(chat,page,status); }
    if (data==='adm:profile-requests') return profileRequestList(chat);
    if (data.startsWith('adm:profile-request:')) return profileRequestDetail(chat,data.slice('adm:profile-request:'.length));
    if (data.startsWith('adm:profile-confirm:')) { const [, , id, action]=data.split(':'); if(!/^\d+$/.test(id)||!['approve','reject'].includes(action)) return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'}); pending.set(String(adminId),{type:'profile-review',id,action,expires:Date.now()+60000}); return adminMessage({chat_id:chat,text:(action==='approve'?'تأیید':'رد')+' درخواست اصلاح #'+id+' را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید نهایی',callback_data:'adm:profile-apply:'+id+':'+action},{text:'بازگشت',callback_data:'adm:profile-request:'+id}]])}); }
    if (data.startsWith('adm:profile-apply:')) { const [, , id, action]=data.split(':'); const p=pending.get(String(adminId)); pending.delete(String(adminId)); if(!p||p.type!=='profile-review'||p.id!==id||p.action!==action||p.expires<Date.now()) return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'}); try { await campaignService.reviewProfileChange({requestId:Number(id),approve:action==='approve',note:'Reviewed via Telegram admin panel'}); await audit(action==='approve'?'approve_profile_change':'reject_profile_change','profile_change_request',id,{source:'telegram'}); return profileRequestDetail(chat,id); } catch(e) { return adminMessage({chat_id:chat,text:'بررسی درخواست انجام نشد: '+e.message}); } }
    if(data.startsWith('adm:order-resend:')){
      const id=data.slice('adm:order-resend:'.length);if(!/^\d+$/.test(id))return adminMessage({chat_id:chat,text:'شناسه سفارش نامعتبر است.'});
      try{const [[o]]=await db.execute("SELECT o.id,o.order_ref,o.total_snapshot,o.currency,o.status,o.campaign_id,p.chat_id,p.business_connection_id,c.name campaign_name FROM payment_orders o JOIN participants p ON p.id=o.participant_id JOIN campaigns c ON c.id=o.campaign_id WHERE o.id=? LIMIT 1",[id]);if(!o||o.status!=='pending_payment')throw new Error('این سفارش دیگر در انتظار پرداخت نیست.');if(!o.chat_id||!o.business_connection_id)throw new Error('مسیر گفتگوی شرکت‌کننده در دسترس نیست.');const card=await bankCardService.currentCampaignCard(o.campaign_id);const sent=await adminMessage({chat_id:o.chat_id,business_connection_id:o.business_connection_id,text:'🧾 اطلاعات پرداخت سفارش شما\nکمپین: '+o.campaign_name+'\nشماره سفارش: '+o.order_ref+'\nمبلغ: '+o.total_snapshot+' '+o.currency+'\n\nشماره کارت: '+card.card_number+'\nبه نام: '+card.cardholder_name+'\n\nپس از پرداخت، تصویر رسید را همین‌جا ارسال کنید.'});if(sent){try{await bankCardService.recordDelivery({orderId:Number(id),card});}catch(deliveryError){console.error('Payment card resend audit failed for order '+id+':',deliveryError.message);}}try{await audit('resend_payment_card','payment_order',id,{card_id:card.id,source:'telegram'});}catch(auditError){console.error('Payment card resend audit log failed for order '+id+':',auditError.message);}await adminMessage({chat_id:chat,text:'اطلاعات پرداخت با کارت جاری کمپین برای شرکت‌کننده ارسال شد.'});return orderDetail(chat,id);}catch(e){return adminMessage({chat_id:chat,text:'ارسال مجدد انجام نشد: '+e.message});}
    }
    if (data.startsWith('adm:order:')) return orderDetail(chat,data.slice('adm:order:'.length));
    if (data.startsWith('adm:order-confirm:')) { const [, , id, action]=data.split(':'); if(!/^\d+$/.test(id)||!['approve','reject'].includes(action)) return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'}); pending.set(String(adminId),{type:'order-review',id,action,expires:Date.now()+60000}); return adminMessage({chat_id:chat,text:(action==='approve'?'تأیید':'رد')+' پرداخت سفارش #'+id+' را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید نهایی',callback_data:'adm:order-apply:'+id+':'+action},{text:'بازگشت',callback_data:'adm:order:'+id}]])}); }
    if (data.startsWith('adm:order-apply:')) { const [, , id, action]=data.split(':'); const p=pending.get(String(adminId)); pending.delete(String(adminId)); if(!p||p.type!=='order-review'||p.id!==id||p.action!==action||p.expires<Date.now()) return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'}); try { await campaignService.reviewManualPayment({orderId:Number(id),approve:action==='approve',note:'Reviewed via Telegram admin panel'}); await audit(action==='approve'?'approve_payment':'reject_payment','payment_order',id,{source:'telegram'}); await adminMessage({chat_id:chat,text:action==='approve'?'✅ پرداخت تأیید و کدها صادر شدند.':'پرداخت رد شد.',reply_markup:keyboard([[{text:'سفارش‌های در انتظار',callback_data:'adm:orders'}]])}); return orderDetail(chat,id); } catch(e) { return adminMessage({chat_id:chat,text:'بررسی سفارش انجام نشد: '+e.message}); } }

    if(data==='adm:campaign-wizard-back'){const p=pending.get(String(adminId));if(!p||p.type!=='campaign-wizard')return adminMessage({chat_id:chat,text:'فرم منقضی شده است.'});p.step=p.values.payment_mode==='free'&&p.step===4?2:Math.max(0,p.step-1);p.reviewEdit=false;p.expires=Date.now()+1800000;return adminMessage({chat_id:chat,text:campaignWizardPrompt(p),reply_markup:campaignWizardMarkup(p)});}
    if(data.startsWith('adm:campaign-wizard-payment:')){const p=pending.get(String(adminId)),mode=data.slice('adm:campaign-wizard-payment:'.length);if(!p||p.type!=='campaign-wizard'||p.step!==2||!['free','manual'].includes(mode))return adminMessage({chat_id:chat,text:'انتخاب نوع پرداخت نامعتبر یا منقضی است.'});p.values.payment_mode=mode;if(mode==='free'){p.values.price_per_code='0';p.values.payment_card_id='-';p.step=4;}else{p.step=3;}p.expires=Date.now()+1800000;return adminMessage({chat_id:chat,text:campaignWizardPrompt(p),reply_markup:campaignWizardMarkup(p)});}
    if(data.startsWith('adm:campaign-wizard-draw-method:')||data.startsWith('adm:campaign-wizard-draw-basis:')||data.startsWith('adm:campaign-wizard-card:')){
      const p=pending.get(String(adminId));
      if(!p||p.type!=='campaign-wizard'||p.expires<Date.now())return adminMessage({chat_id:chat,text:'فرم منقضی شده است؛ دوباره شروع کن.'});
      const isMethod=data.startsWith('adm:campaign-wizard-draw-method:');
      const isBasis=data.startsWith('adm:campaign-wizard-draw-basis:');
      const selected=data.slice(data.lastIndexOf(':')+1);
      const expected=isMethod?'draw_method':isBasis?'draw_basis':'payment_card_id';
      if(campaignWizardFields[p.step]?.key!==expected)return adminMessage({chat_id:chat,text:'این انتخاب مربوط به مرحله فعلی نیست.'});
      if(isMethod&&!['system','live_wheel'].includes(selected))return adminMessage({chat_id:chat,text:'روش قرعه‌کشی نامعتبر است.'});
      if(isBasis&&!['per_code','per_participant'].includes(selected))return adminMessage({chat_id:chat,text:'مبنای قرعه‌کشی نامعتبر است.'});
      if(!isMethod&&!isBasis){
        if(!/^\d+$/.test(selected))return adminMessage({chat_id:chat,text:'شناسه کارت نامعتبر است.'});
        const card=await bankCardService.getCard(Number(selected),{activeOnly:true});
        if(!(p.cards||[]).some(c=>Number(c.id)===Number(card.id)))return adminMessage({chat_id:chat,text:'این کارت در فهرست کارت‌های فعال فرم نیست؛ فرم را تازه‌سازی کن.'});
      }
      p.values[expected]=selected;
      if(p.reviewEdit){p.reviewEdit=false;return campaignWizardReview(chat,p);}
      // Free campaigns do not require a bank card; skip the payment-card step entirely.
      if(expected==='draw_basis'&&p.values.payment_mode==='free')return campaignWizardReview(chat,p);
      if(p.step>=campaignWizardFields.length-1)return campaignWizardReview(chat,p);
      p.step++;
      p.expires=Date.now()+1800000;
      return adminMessage({chat_id:chat,text:campaignWizardPrompt(p),reply_markup:campaignWizardMarkup(p)});
    }
    if(data.startsWith('adm:campaign-wizard-edit:')){const p=pending.get(String(adminId));const n=Number(data.slice('adm:campaign-wizard-edit:'.length));if(!p||p.type!=='campaign-wizard'||!Number.isInteger(n)||n<0||n>=campaignWizardFields.length)return adminMessage({chat_id:chat,text:'فرم منقضی شده است.'});p.step=n;p.reviewEdit=true;p.expires=Date.now()+1800000;return adminMessage({chat_id:chat,text:'✏️ اصلاح '+campaignWizardFields[n].label+'\nمقدار فعلی: '+campaignWizardValue(p,campaignWizardFields[n].key)+'\nمقدار جدید را بفرست.',reply_markup:campaignWizardMarkup(p)});}
    if(data==='adm:campaign-wizard-cancel'){pending.delete(String(adminId));return home(chat,'ساخت/ویرایش کمپین لغو شد.');}
    if(data==='adm:campaign-wizard-save'){const p=pending.get(String(adminId));if(!p||p.type!=='campaign-wizard'||p.expires<Date.now())return adminMessage({chat_id:chat,text:'فرم منقضی شده است؛ دوباره شروع کن.'});const v=p.values;const input={...v,price_per_code:Number(digits(v.price_per_code)),max_participants:v.max_participants==='-'?null:Number(digits(v.max_participants)),max_codes:v.max_codes==='-'?null:Number(digits(v.max_codes)),max_codes_per_participant:Number(digits(v.max_codes_per_participant)),winner_count:Number(digits(v.winner_count)),alternate_count:Number(digits(v.alternate_count)),payment_card_id:v.payment_card_id==='-'?null:Number(digits(v.payment_card_id))};try{let result;if(p.editingId){result=await campaignService.updateDraftCampaign(Number(p.editingId),input);await audit('edit_campaign','campaign',p.editingId,{source:'telegram'});}else{result=await campaignService.createCampaign(input);await audit('create_campaign','campaign',result.id,{slug:result.slug,source:'telegram'});}pending.delete(String(adminId));return adminMessage({chat_id:chat,text:(p.editingId?'✅ پیش‌نویس ویرایش شد.':'✅ کمپین در وضعیت پیش‌نویس ساخته شد.')+'\nشناسه: '+(p.editingId||result.id)+'\nSlug: '+(result.slug||v.slug),reply_markup:keyboard([[{text:'مشاهده کمپین',callback_data:'adm:campaign-detail:'+(p.editingId||result.id)}],[{text:'فهرست کمپین‌ها',callback_data:'adm:campaigns'}]])});}catch(e){return adminMessage({chat_id:chat,text:'ذخیره انجام نشد: '+e.message+'\nفرم باز مانده؛ مقادیر را اصلاح کن و دوباره ذخیره بزن.'});}}
    if (data==='adm:campaign-create') return createCampaignPrompt(chat);
    if (data.startsWith('adm:campaign-detail:')) return campaignDetail(chat,data.slice('adm:campaign-detail:'.length));
    if (data.startsWith('adm:campaign-confirm:')) { const [, , id, next]=data.split(':'); if(!/^\d+$/.test(id)||!['open','paused','closed','archived'].includes(next)) return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'}); pending.set(String(adminId),{type:'campaign-status',id,next,expires:Date.now()+60000}); return adminMessage({chat_id:chat,text:'تغییر وضعیت کمپین #'+id+' به '+next+' را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید',callback_data:'adm:campaign-apply:'+id+':'+next},{text:'لغو',callback_data:'adm:campaign-detail:'+id}]])}); }
    if (data.startsWith('adm:campaign-apply:')) { const [, , id, next]=data.split(':'); const p=pending.get(String(adminId)); pending.delete(String(adminId)); if(!p||p.type!=='campaign-status'||p.id!==id||p.next!==next||p.expires<Date.now()) return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'}); try { await campaignService.setCampaignStatus(Number(id),next,'telegram admin confirmation'); return campaignDetail(chat,id); } catch(e) { return adminMessage({chat_id:chat,text:'تغییر وضعیت انجام نشد: '+e.message}); } }
    if (data==='adm:export') return exportMenu(chat);
    if (data==='adm:export:help') return adminMessage({chat_id:chat,text:'برای خروجی مستقیم می‌توانی از دستورهای زیر هم استفاده کنی:\n/export active today\n/export all 7d\n/export inactive 30d\n\nمقادیر وضعیت: all, active, inactive و بازه: all, today, 7d, 30d'});
    if (data.startsWith('adm:export-run:')) { const [, , status='all', period='all']=data.split(':'); return exportCsv(chat,status,period); }
    if (data.startsWith('adm:export:')) return exportPeriodMenu(chat,data.slice('adm:export:'.length));
    if (data==='adm:support') return supportList(chat,'open',0);
    if (data.startsWith('adm:support-page:')) { const [, , status='open', page='0']=data.split(':'); return supportList(chat,status,page); }
    if (data.startsWith('adm:support:')) return supportList(chat,data.slice('adm:support:'.length),0);
    if (data.startsWith('adm:support-ticket:')) return supportDetail(chat,data.slice('adm:support-ticket:'.length));
    if (data.startsWith('adm:support-close:')) return setSupportStatus(chat,data.slice('adm:support-close:'.length),'closed');
    if (data.startsWith('adm:support-reopen:')) return setSupportStatus(chat,data.slice('adm:support-reopen:'.length),'open');
    if (data.startsWith('adm:support-reply-help:')) return adminMessage({chat_id:chat,text:'برای پاسخ به این تیکت در همین گفت‌وگوی خصوصی دستور زیر را ارسال کنید:\n/reply '+data.slice('adm:support-reply-help:'.length)+' متن پاسخ'});
    if (data==='adm:audit') return auditLog(chat);
    if (data==='adm:export') return exportMenu(chat);
    if (data.startsWith('adm:export-run:')) { const [, , status='all', period='all']=data.split(':'); return exportCsv(chat,status,period); }
    if (data.startsWith('adm:export:')) return exportPeriodMenu(chat,data.slice('adm:export:'.length));
    if (data==='adm:audit') return auditLog(chat);
    return adminMessage({chat_id:chat,text:'عملیات ناشناخته است.'});
  }

  async function handleMessage(m) {
    if (!m?.from || String(m.from.id)!==String(adminId) || m.chat?.type!=='private') return false;
    const text=String(m.text||'').trim();
    if (text.toLowerCase().startsWith('/export')) { const parts=text.toLowerCase().split(/\s+/); return exportCsv(m.chat.id,parts[1]||'active',parts[2]||'all'); }
    if (text==='پنل'||text.toLowerCase()==='/panel'||text.toLowerCase()==='/start') { return home(m.chat.id); }

    const liveWheel=pending.get(String(adminId));
    if(liveWheel?.type==='live-wheel-result'&&text){
      if(liveWheel.expires<Date.now()){pending.delete(String(adminId));return adminMessage({chat_id:m.chat.id,text:'مهلت ثبت نتیجه تمام شد؛ دوباره از فهرست قرعه‌کشی شروع کنید.'});}
      if(text.toLowerCase()==='/cancel'){pending.delete(String(adminId));return adminMessage({chat_id:m.chat.id,text:'ثبت نتیجه لغو شد.'});}
      if(text.toLowerCase()==='/back'){
        liveWheel.step=liveWheel.step==='hash'?'evidence':'references';
        return adminMessage({chat_id:m.chat.id,text:liveWheel.step==='references'?'شناسه‌های واجدان را دوباره با ویرگول یا فاصله ارسال کنید.':'لینک یا شناسه مدرک را ارسال کنید.'});
      }
      if(liveWheel.step==='references'){
        const refs=text.split(/[\\s,;،]+/).map(x=>x.trim()).filter(Boolean);
        if(refs.length!==liveWheel.required||new Set(refs).size!==refs.length)return adminMessage({chat_id:m.chat.id,text:'باید دقیقاً '+liveWheel.required+' شناسه یکتا ارسال کنید. شناسه‌ها را با ویرگول یا فاصله جدا کنید.'});
        const placeholders=refs.map(()=>'?').join(',');
        const [found]=await db.execute("SELECT candidate_reference FROM draw_candidates WHERE draw_id=? AND eligibility='eligible' AND candidate_reference IN ("+placeholders+")",[liveWheel.drawId,...refs]);
        if(found.length!==refs.length)return adminMessage({chat_id:m.chat.id,text:'حداقل یکی از شناسه‌ها در Snapshot این قرعه‌کشی وجود ندارد. شناسه‌ها را بررسی و دوباره ارسال کنید.'});
        liveWheel.references=refs;liveWheel.step='evidence';
        return adminMessage({chat_id:m.chat.id,text:'شناسه‌ها پذیرفته شد. اکنون لینک ویدئو، لینک مدرک یا شناسه قابل‌بررسی مدرک اجرای گردونه را ارسال کنید (حداکثر ۲۵۵ نویسه).'});
      }
      if(liveWheel.step==='evidence'){
        const evidence=text.trim();
        if(evidence.length<3||evidence.length>255)return adminMessage({chat_id:m.chat.id,text:'لینک یا شناسه مدرک باید بین ۳ تا ۲۵۵ نویسه باشد.'});
        liveWheel.externalReference=evidence;liveWheel.step='hash';
        return adminMessage({chat_id:m.chat.id,text:'در صورت داشتن SHA-256 فایل مدرک، هش ۶۴ رقمی را ارسال کنید؛ اگر ندارید فقط - بفرستید. برای بازگشت /back را بفرستید.'});
      }
      if(liveWheel.step==='hash'){
        const hash=text.trim()==='-'?null:text.trim().toLowerCase();
        if(hash&&!/^[a-f0-9]{64}$/.test(hash))return adminMessage({chat_id:m.chat.id,text:'هش باید دقیقاً ۶۴ رقم هگزادسیمال باشد یا برای رد کردن - بفرستید.'});
        try{
          const result=await drawService.submitLiveWheelResults({drawId:Number(liveWheel.drawId),candidateReferences:liveWheel.references,externalReference:liveWheel.externalReference,evidenceHash:hash});
          pending.delete(String(adminId));
          return adminMessage({chat_id:m.chat.id,text:'✅ نتایج گردونه در انتظار تأیید ثبت شد.\\nقرعه‌کشی #'+result.drawId+'\\nتعداد نتایج: '+liveWheel.references.length+'\\nمدرک: '+liveWheel.externalReference+'\\n\\nتا زمان تأیید مدیر، نتایج نهایی نیستند.',reply_markup:keyboard([[{text:'تأیید نهایی نتیجه',callback_data:'adm:draw-approve:'+result.drawId}],[{text:'مشاهده قرعه‌کشی',callback_data:'adm:draw-view:'+result.drawId}]])});
        }catch(error){return adminMessage({chat_id:m.chat.id,text:'ثبت نتیجه انجام نشد: '+error.message+'\\nبرای اصلاح ورودی از /back استفاده کنید.'});}
      }
    }
    const cardMode=pending.get(String(adminId));
    if(cardMode?.type==='card-wizard' && text && (text.toLowerCase()==='/back'||!text.startsWith('/'))){
      if(cardMode.expires<Date.now()){pending.delete(String(adminId));return adminMessage({chat_id:m.chat.id,text:'مهلت فرم کارت تمام شده است؛ دوباره شروع کن.'});}
      if(text.toLowerCase()==='/back'){cardMode.step=Math.max(0,cardMode.step-1);return adminMessage({chat_id:m.chat.id,text:cardWizardPrompt(cardMode),reply_markup:cardWizardMarkup()});}
      const field=cardWizardFields[cardMode.step],value=text.trim();
      const normalized=field.key==='cardNumber'?digits(value).replace(/\s+/g,''):value;
      const valid={
        label:()=>normalized.length>=2&&normalized.length<=100,
        bankName:()=>normalized==='-'||normalized.length<=100,
        cardNumber:()=>/^\d{16}$/.test(normalized),
        cardholderName:()=>normalized.length>=3&&normalized.length<=150
      };
      if(!valid[field.key]())return adminMessage({chat_id:m.chat.id,text:'مقدار نامعتبر است. '+field.hint+'\nدوباره ارسال کن؛ فرم پاک نمی‌شود.',reply_markup:cardWizardMarkup()});
      cardMode.values[field.key]=field.key==='bankName'&&normalized==='-'?'':normalized;
      if(cardMode.reviewEdit){cardMode.reviewEdit=false;return cardWizardReview(m.chat.id,cardMode);}
      if(cardMode.step<cardWizardFields.length-1){cardMode.step++;return adminMessage({chat_id:m.chat.id,text:cardWizardPrompt(cardMode),reply_markup:cardWizardMarkup()});}
      return cardWizardReview(m.chat.id,cardMode);
    }
    const wizard=pending.get(String(adminId));
    if(wizard?.type==='campaign-wizard' && text && (text.toLowerCase()==='/back' || !text.startsWith('/'))){
      if(wizard.expires<Date.now()){pending.delete(String(adminId));return adminMessage({chat_id:m.chat.id,text:'مهلت فرم تمام شد؛ دوباره شروع کن.'});}
      if(text.toLowerCase()==='/back'){wizard.step=wizard.values.payment_mode==='free'&&wizard.step===4?2:Math.max(0,wizard.step-1);return adminMessage({chat_id:m.chat.id,text:campaignWizardPrompt(wizard),reply_markup:campaignWizardMarkup(wizard)});}
      const field=campaignWizardFields[wizard.step],value=digits(text).trim();
      const valid={
        name:()=>value.length>=2&&value.length<=150,
        slug:()=>/^[a-z0-9][a-z0-9-]{1,79}$/.test(value),
        payment_mode:()=>['free','manual'].includes(value.toLowerCase()),
        price_per_code:()=>/^\d+$/.test(value)&&Number(value)>=0&&(wizard.values.payment_mode==='free'?Number(value)===0:Number(value)>0),
        max_participants:()=>value==='-'||(/^\d+$/.test(value)&&Number(value)>0),
        max_codes:()=>value==='-'||(/^\d+$/.test(value)&&Number(value)>0),
        max_codes_per_participant:()=>/^\d+$/.test(value)&&Number(value)>0,
        winner_count:()=>/^\d+$/.test(value)&&Number(value)>0,
        alternate_count:()=>/^\d+$/.test(value)&&Number(value)>=0,
        draw_method:()=>['system','live_wheel','hybrid'].includes(value),
        draw_basis:()=>['per_code','per_participant'].includes(value),
        payment_card_id:()=>wizard.values.payment_mode==='free'?value==='-':/^\d+$/.test(value)&&Number(value)>0
      };
      if(!valid[field.key]())return adminMessage({chat_id:m.chat.id,text:'مقدار نامعتبر است. '+field.hint+'\nدوباره ارسال کن؛ فرم پاک نمی‌شود.',reply_markup:campaignWizardMarkup(wizard)});
      wizard.values[field.key]=field.key==='payment_mode'?value.toLowerCase():value;
      if(field.key==='payment_mode'&&wizard.values.payment_mode==='free'){wizard.values.price_per_code='0';wizard.values.payment_card_id='-';wizard.step=4;return adminMessage({chat_id:m.chat.id,text:campaignWizardPrompt(wizard),reply_markup:campaignWizardMarkup(wizard)});}
      if(wizard.reviewEdit){wizard.reviewEdit=false;return campaignWizardReview(m.chat.id,wizard);}
      if(wizard.values.payment_mode==='free'){wizard.values.price_per_code='0';wizard.values.payment_card_id='-';}
      if(wizard.values.payment_mode==='free'&&wizard.step===10){return campaignWizardReview(m.chat.id,wizard);}
      if(wizard.step<campaignWizardFields.length-1){wizard.step++;return adminMessage({chat_id:m.chat.id,text:campaignWizardPrompt(wizard),reply_markup:campaignWizardMarkup(wizard)});}
      return campaignWizardReview(m.chat.id,wizard);
    }
    if (text.toLowerCase()==='/newcampaign') return createCampaignPrompt(m.chat.id);
    if (text.toLowerCase()==='/cancel') { pending.delete(String(adminId)); return home(m.chat.id,'عملیات لغو شد.'); }
  }
  const handleCallback = async (q) => {
    if (!isAdmin(q)) return false;
    const callbackId=String(q.id||'');
    if(!callbackId)return false;
    if(completedCallbackIds.has(callbackId)||callbackInFlight.has(callbackId))return true;
    const actionKey=String(q.message?.chat?.id||'')+':'+String(q.message?.message_id||'')+':'+String(q.data||'');
    if(actionInFlight.has(actionKey)){
      await tg('answerCallbackQuery',{callback_query_id:q.id,text:'این عملیات در حال اجراست؛ لطفاً کمی صبر کنید.'});
      return true;
    }
    callbackInFlight.set(callbackId,true);
    actionInFlight.set(actionKey,callbackId);
    try {
      const result=await processCallback(q);
      completedCallbackIds.add(callbackId);
      completedCallbackOrder.push(callbackId);
      while(completedCallbackOrder.length>2000){const expired=completedCallbackOrder.shift();completedCallbackIds.delete(expired);}
      return result;
    } finally {
      callbackInFlight.delete(callbackId);
      if(actionInFlight.get(actionKey)===callbackId)actionInFlight.delete(actionKey);
    }
  };
  return { handleCallback, handleMessage };
}
module.exports = { createAdminTelegram };
