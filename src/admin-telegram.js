'use strict';
const crypto = require('node:crypto');
const { normalizePhone, validPhone, normalizeInstagram, validInstagram, validFullName } = require('./domain');

function createAdminTelegram({ db, tg, tgDocument, adminId, registrationOpen, campaignService, bankCardService }) {
  const searchModes = new Map();
  const editModes = new Map();
  const pending = new Map();
  const uiMessageIds = new Map();
  const callbackInFlight = new Map();
  const actionInFlight = new Map();
  const completedCallbackIds = new Set();
  const completedCallbackOrder = [];
  const isAdmin = (q) => String(q?.from?.id || '') === String(adminId) && q?.message?.chat?.type === 'private';
  const menu = [
    [{ text: '📊 داشبورد', callback_data: 'adm:stats' }, { text: '👥 شرکت‌کنندگان', callback_data: 'adm:entries:0' }],
    [{ text: '🎟 کدها و خروجی', callback_data: 'adm:export' }, { text: '⚙️ کمپین قدیمی', callback_data: 'adm:campaign' }],
    [{ text: '🧩 مدیریت کمپین‌ها', callback_data: 'adm:campaigns' }],
    [{ text: '💳 مدیریت کارت‌های بانکی', callback_data: 'adm:cards' }],
    [{ text: '💳 سفارش‌ها و رسیدها', callback_data: 'adm:orders' }],
    [{ text: '📝 درخواست‌های اصلاح پروفایل', callback_data: 'adm:profile-requests' }],
    [{ text: '🏆 قرعه‌کشی', callback_data: 'adm:draw' }, { text: '🧾 رخدادها', callback_data: 'adm:audit' }],
    [{ text: '🔎 جستجو', callback_data: 'adm:search' }, { text: '🔄 تازه‌سازی', callback_data: 'adm:home' }]
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
    const [[legacy]] = await db.query("SELECT COUNT(*) total, SUM(status='active') active, SUM(status='inactive') inactive, SUM(status='deleted') deleted FROM lottery_entries");
    const [[legacyToday]] = await db.query("SELECT COUNT(*) today FROM lottery_entries WHERE status='active' AND DATE(created_at)=CURDATE()");
    const [[sessions]] = await db.query("SELECT COUNT(*) pending FROM lottery_sessions");
    const [[webhooks]] = await db.query("SELECT COUNT(*) failed FROM webhook_inbox WHERE status='failed'");
    const [[outbox]] = await db.query("SELECT COUNT(*) failed FROM telegram_notification_outbox WHERE status='failed'");
    const [[campaigns]] = await db.query("SELECT COUNT(*) total, SUM(status='open') open, SUM(status='draft') draft, SUM(status='paused') paused, SUM(status='closed') closed FROM campaigns");
    const [[participants]] = await db.query("SELECT COUNT(*) total, SUM(status='active') active FROM participants");
    const [[entryFunnel]] = await db.query("SELECT COUNT(*) total, SUM(status='active') completed, SUM(status='pending') pending, SUM(status='inactive') inactive, SUM(status IN ('cancelled','disqualified')) excluded FROM campaign_entries");
    const [[codes]] = await db.query("SELECT COUNT(*) total FROM campaign_codes WHERE status='active'");
    const [[orders]] = await db.query("SELECT COUNT(*) total, SUM(status='pending_payment') pending, SUM(status='receipt_submitted') receipts, SUM(status='approved') approved, SUM(status='rejected') rejected FROM payment_orders");
    const [revenue] = await db.query("SELECT currency,SUM(amount) total FROM payment_transactions WHERE status='confirmed' GROUP BY currency ORDER BY currency");
    const [[profileRequests]] = await db.query("SELECT COUNT(*) pending FROM profile_change_requests WHERE status='pending'");
    const [[draw]] = await db.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed'");
    const money = revenue.length ? revenue.map(x => Number(x.total || 0).toLocaleString('en-US')+' '+x.currency).join(' · ') : '۰';
    return adminMessage({ chat_id: chat, text:
      '📊 داشبورد مدیریتی iStore\n\n' +
      '🧩 کمپین‌ها: '+Number(campaigns.total||0)+' | باز: '+Number(campaigns.open||0)+' | پیش‌نویس: '+Number(campaigns.draft||0)+' | متوقف: '+Number(campaigns.paused||0)+' | بسته: '+Number(campaigns.closed||0)+
      '\n👥 پروفایل‌های چندکمپینی: '+Number(participants.total||0)+' | فعال: '+Number(participants.active||0)+
      '\n🧭 عضویت کمپین: '+Number(entryFunnel.completed||0)+' تکمیل‌شده از '+Number(entryFunnel.total||0)+' | معلق: '+Number(entryFunnel.pending||0)+' | غیرفعال/حذف‌شده: '+(Number(entryFunnel.inactive||0)+Number(entryFunnel.excluded||0))+' | نرخ تکمیل: '+(Number(entryFunnel.total||0)?Math.round(Number(entryFunnel.completed||0)*100/Number(entryFunnel.total)):0)+'٪'+
      '\n🎟 کدهای فعال: '+Number(codes.total||0)+
      '\n💳 سفارش‌ها: '+Number(orders.total||0)+' | منتظر پرداخت: '+Number(orders.pending||0)+' | رسید در انتظار: '+Number(orders.receipts||0)+
      '\n✅ پرداخت‌های تأییدشده: '+Number(orders.approved||0)+' | ردشده: '+Number(orders.rejected||0)+
      '\n💰 مجموع تراکنش تأییدشده (به تفکیک ارز): '+money+
      '\n📝 درخواست اصلاح پروفایل معلق: '+Number(profileRequests.pending||0)+
      '\n\n📦 سیستم قدیمی\n👥 پرونده‌ها: '+Number(legacy.total||0)+' | فعال: '+Number(legacy.active||0)+' | غیرفعال: '+Number(legacy.inactive||0)+' | حذف منطقی: '+Number(legacy.deleted||0)+
      '\n📅 ثبت‌نام قدیمی امروز: '+Number(legacyToday.today||0)+
      '\n⌛ نشست نیمه‌کاره: '+Number(sessions.pending||0)+
      '\n⚠️ خطاهای Webhook: '+Number(webhooks.failed||0)+' | اعلان ناموفق: '+Number(outbox.failed||0)+
      '\n🏆 قرعه‌کشی قدیمی: '+(draw?.setting_value==='true'?'انجام شده':'انجام نشده'),
      reply_markup: keyboard([[{text:'🧩 کمپین‌ها',callback_data:'adm:campaigns'},{text:'💳 سفارش‌ها',callback_data:'adm:orders'}],[{text:'📝 درخواست‌های اصلاح',callback_data:'adm:profile-requests'},{text:'🧾 رخدادها',callback_data:'adm:audit'}],[{text:'📈 گزارش کمپین‌ها',callback_data:'adm:reports'}],[{text:'↩️ منوی اصلی',callback_data:'adm:home'}]]) });
  }
  async function entries(chat, page, status = 'all', period = 'all') {
    const p = Math.max(0, Math.min(10000, Number(page) || 0));
    if (!['all','active','inactive'].includes(status) || !['all','today','7d','30d'].includes(period)) {
      return adminMessage({ chat_id: chat, text: 'فیلتر نامعتبر است.' });
    }
    const clauses = ["status <> 'deleted'"];
    const params = [];
    if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
    if (period === 'today') clauses.push('created_at >= CURDATE()');
    if (period === '7d') clauses.push('created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)');
    if (period === '30d') clauses.push('created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
    const where = clauses.join(' AND ');
    const [rows] = await db.execute(
      'SELECT id,full_name,phone,instagram,raffle_code,status FROM lottery_entries WHERE ' + where + ' ORDER BY id DESC LIMIT 8 OFFSET ?',
      [...params, p * 8]
    );
    const buttons = rows.map(x => [{ text: (x.status === 'active' ? '✅ ' : '⏸ ') + String(x.full_name).slice(0, 28) + ' · ' + x.raffle_code, callback_data: 'adm:entry:' + x.id }]);
    const nav = [];
    const state = status + ':' + period;
    if (p > 0) nav.push({ text: '⬅️ قبلی', callback_data: 'adm:entries:' + (p - 1) + ':' + state });
    if (rows.length === 8) nav.push({ text: 'بعدی ➡️', callback_data: 'adm:entries:' + (p + 1) + ':' + state });
    if (nav.length) buttons.push(nav);
    buttons.push([{text:'وضعیت: '+status,callback_data:'adm:entry-status:'+period},{text:'تاریخ: '+period,callback_data:'adm:entry-period:'+status}]);
    buttons.push([{text:'🔎 جستجو',callback_data:'adm:search'}, {text:'↩️ منوی اصلی',callback_data:'adm:home'}]);
    return adminMessage({ chat_id: chat, text: '👥 شرکت‌کنندگان · صفحه ' + (p + 1) + '\nبرای مشاهده جزئیات یک نفر را انتخاب کنید:', reply_markup: keyboard(buttons) });
  }
  async function detail(chat, id) {
    const [rows] = await db.execute('SELECT id,full_name,phone,instagram,raffle_code,status,created_at,updated_at,deletion_reason FROM lottery_entries WHERE id=? LIMIT 1', [id]);
    if (!rows.length) return adminMessage({ chat_id: chat, text: 'شرکت‌کننده پیدا نشد.' });
    const x = rows[0];
    const [hist] = await db.execute('SELECT raffle_code,action,actor,created_at FROM lottery_code_history WHERE entry_id=? ORDER BY id DESC LIMIT 5', [id]);
    const history = hist.length ? hist.map(h => h.action + ' · ' + h.raffle_code + ' · ' + h.actor).join('\n') : 'بدون سابقه کد';
    const rowsKb = [[{text:'📝 تاریخچه کد',callback_data:'adm:history:'+id}]];
    if (x.status !== 'deleted') {
      rowsKb.push([{text:'✏️ ویرایش اطلاعات',callback_data:'adm:edit:'+id},{text:'🗑 حذف منطقی',callback_data:'adm:delete:'+id}]);
      rowsKb.push([{text:x.status === 'active' ? '⏸ غیرفعال‌سازی' : '✅ فعال‌سازی',callback_data:'adm:confirm-status:'+id+':'+(x.status === 'active' ? 'inactive' : 'active')}]);
    }
    rowsKb.push([{text:'👥 فهرست',callback_data:'adm:entries:0'},{text:'↩️ منوی اصلی',callback_data:'adm:home'}]);
    return adminMessage({ chat_id: chat, text:
      '👤 پرونده شرکت‌کننده #' + x.id + '\n\nنام: ' + x.full_name +
      '\nموبایل: ' + x.phone + '\nاینستاگرام: @' + x.instagram +
      '\nکد: ' + x.raffle_code + '\nوضعیت: ' + x.status +
      '\nثبت: ' + x.created_at + '\n\nآخرین سوابق کد:\n' + history,
      reply_markup: keyboard(rowsKb) });
  }
  async function history(chat, id) {
    const [rows] = await db.execute('SELECT raffle_code,action,actor,created_at FROM lottery_code_history WHERE entry_id=? ORDER BY id DESC LIMIT 30', [id]);
    const body = rows.length ? rows.map((x,i) => (i+1)+') '+x.action+' | '+x.raffle_code+' | '+x.actor+' | '+x.created_at).join('\n') : 'سابقه‌ای ثبت نشده است.';
    return adminMessage({ chat_id: chat, text: '🧾 تاریخچه کدها\n\n'+body, reply_markup: keyboard([[{text:'↩️ پرونده',callback_data:'adm:entry:'+id}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]]) });
  }
  async function campaign(chat) {
    const open = await registrationOpen();
    const [[draw]] = await db.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed'");
    return adminMessage({ chat_id: chat, text:
      '⚙️ کنترل کمپین\n\nثبت‌نام: ' + (open ? '🟢 باز' : '🔴 بسته') +
      '\nقرعه‌کشی: ' + (draw?.setting_value === 'true' ? 'انجام شده' : 'انجام نشده') +
      '\n\nتغییر وضعیت فقط پس از تأیید انجام می‌شود.',
      reply_markup: keyboard([
        [{text:open?'🔒 درخواست بستن ثبت‌نام':'🔓 درخواست بازکردن ثبت‌نام',callback_data:'adm:confirm-registration:'+(open?'false':'true')}],
        [{text:'↩️ منوی اصلی',callback_data:'adm:home'}]
      ]) });
  }
  async function exportCsv(chat, status = 'active', period = 'all') {
    if (!['all','active','inactive'].includes(status) || !['all','today','7d','30d'].includes(period)) {
      return adminMessage({chat_id:chat,text:'فیلتر خروجی نامعتبر است.'});
    }
    const clauses = ["status <> 'deleted'"];
    const params = [];
    if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
    if (period === 'today') clauses.push('created_at >= CURDATE()');
    if (period === '7d') clauses.push('created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)');
    if (period === '30d') clauses.push('created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
    const [rows] = await db.execute('SELECT full_name,phone,instagram,raffle_code,status,created_at FROM lottery_entries WHERE '+clauses.join(' AND ')+' ORDER BY created_at DESC',params);
    const cell = v => { let s=String(v??''); if (/^[\s]*[=+\-@]/.test(s)) s="'"+s; return '"'+s.replace(/"/g,'""')+'"'; };
    const csv='\uFEFF'+[['نام','موبایل','اینستاگرام','کد','وضعیت','زمان'],...rows.map(x=>[x.full_name,x.phone,'@'+x.instagram,x.raffle_code,x.status,x.created_at])].map(r=>r.map(cell).join(',')).join('\r\n');
    return tgDocument(chat,'istore-lottery.csv',csv,'text/csv;charset=utf-8');
  }
  async function exportMenu(chat) {
    return adminMessage({chat_id:chat,text:'ابتدا وضعیت شرکت‌کننده را برای خروجی CSV انتخاب کنید:',reply_markup:keyboard([
      [{text:'همه وضعیت‌ها',callback_data:'adm:export:all'},{text:'فعال‌ها',callback_data:'adm:export:active'}],
      [{text:'غیرفعال‌ها',callback_data:'adm:export:inactive'}],
      [{text:'راهنما',callback_data:'adm:export:help'}],
      [{text:'منوی اصلی',callback_data:'adm:home'}]
    ])});
  }
  async function exportPeriodMenu(chat,status) {
    if(!['all','active','inactive'].includes(status))return adminMessage({chat_id:chat,text:'فیلتر وضعیت خروجی نامعتبر است.'});
    return adminMessage({chat_id:chat,text:'بازه زمانی خروجی CSV را انتخاب کنید:',reply_markup:keyboard([
      [{text:'همه تاریخ‌ها',callback_data:'adm:export-run:'+status+':all'}],
      [{text:'امروز',callback_data:'adm:export-run:'+status+':today'},{text:'۷ روز اخیر',callback_data:'adm:export-run:'+status+':7d'}],
      [{text:'۳۰ روز اخیر',callback_data:'adm:export-run:'+status+':30d'}],
      [{text:'↩️ بازگشت',callback_data:'adm:export'}]
    ])});
  }
  async function campaignReports(chat) {
    const [rows] = await db.execute(`
      SELECT c.id,c.name,c.status,
        COUNT(DISTINCT ce.id) AS total_entries,
        COUNT(DISTINCT CASE WHEN ce.status='active' THEN ce.id END) AS completed_entries,
        COUNT(DISTINCT CASE WHEN ce.status='pending' THEN ce.id END) AS pending_entries,
        COUNT(DISTINCT CASE WHEN ce.status IN ('inactive','cancelled','disqualified') THEN ce.id END) AS excluded_entries,
        COUNT(DISTINCT CASE WHEN cc.status='active' THEN cc.id END) AS active_codes,
        COUNT(DISTINCT CASE WHEN o.status='approved' THEN o.id END) AS approved_orders
      FROM campaigns c
      LEFT JOIN campaign_entries ce ON ce.campaign_id=c.id
      LEFT JOIN campaign_codes cc ON cc.campaign_id=c.id AND cc.entry_id=ce.id
      LEFT JOIN payment_orders o ON o.campaign_id=c.id AND o.entry_id=ce.id
      GROUP BY c.id,c.name,c.status
      ORDER BY c.id DESC LIMIT 20
    `);
    if (!rows.length) return adminMessage({chat_id:chat,text:'هنوز کمپینی برای گزارش وجود ندارد.',reply_markup:keyboard([[{text:'↩️ داشبورد',callback_data:'adm:stats'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]])});
    const body=rows.map(r=>{
      const total=Number(r.total_entries||0),done=Number(r.completed_entries||0);
      const rate=total?Math.round(done*100/total):0;
      return '#'+r.id+' '+r.name+' · '+r.status+
        '\nثبت‌نام نهایی: '+done+'/'+total+' ('+rate+'٪) · معلق: '+Number(r.pending_entries||0)+
        '\nغیرفعال/حذف‌شده: '+Number(r.excluded_entries||0)+' · کد فعال: '+Number(r.active_codes||0)+
        ' · سفارش تأییدشده: '+Number(r.approved_orders||0);
    }).join('\n\n');
    return adminMessage({chat_id:chat,text:'📈 گزارش مدیریتی کمپین‌ها\n\nنرخ تکمیل = عضویت‌های فعال ÷ کل پرونده‌های ایجادشده در کمپین. این شاخص نرخ تبدیل شروع گفتگو به ثبت‌نام نیست؛ نشست‌های لغوشده/پاک‌شده در سامانه فعلی تاریخچه دائمی ندارند.\n\n'+body,reply_markup:keyboard([[{text:'↻ تازه‌سازی',callback_data:'adm:reports'}],[{text:'↩️ داشبورد',callback_data:'adm:stats'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]])});
  }
  async function auditLog(chat) {
    const [rows] = await db.query('SELECT action,entity_type,entity_id,created_at FROM admin_audit_log ORDER BY id DESC LIMIT 15');
    const body = rows.length ? rows.map((x,i)=>(i+1)+') '+x.action+' · '+x.entity_type+' #'+(x.entity_id||'-')+'\n'+x.created_at).join('\n\n') : 'هنوز رخدادی ثبت نشده است.';
    return adminMessage({chat_id:chat,text:'🧾 ۱۵ رخداد اخیر\n\n'+body,reply_markup:keyboard([[{text:'↩️ منوی اصلی',callback_data:'adm:home'}]])});
  }
  async function drawHistory(chat, page = 0) {
    const p = Math.max(0, Math.min(10000, Number(page) || 0));
    const [rows] = await db.execute(
      'SELECT d.id,d.winner_entry_id,d.winner_code,d.drawn_by,d.created_at,COUNT(p.entry_id) AS eligible_count FROM lottery_draws d LEFT JOIN lottery_draw_participants p ON p.draw_id=d.id GROUP BY d.id,d.winner_entry_id,d.winner_code,d.drawn_by,d.created_at ORDER BY d.id DESC LIMIT 8 OFFSET ?',
      [p * 8]
    );
    if (!rows.length && p === 0) return adminMessage({chat_id:chat,text:'هنوز قرعه‌کشی ثبت‌شده‌ای وجود ندارد.',reply_markup:keyboard([[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]])});
    const buttons = rows.map(x => [{text:'🏆 قرعه‌کشی #'+x.id+' · '+x.winner_code,callback_data:'adm:draw-detail:'+x.id}]);
    const nav=[];
    if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'adm:draw-history:'+(p-1)});
    if(rows.length===8)nav.push({text:'بعدی ➡️',callback_data:'adm:draw-history:'+(p+1)});
    if(nav.length)buttons.push(nav);
    buttons.push([{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    return adminMessage({chat_id:chat,text:'📚 تاریخچه قرعه‌کشی · صفحه '+(p+1)+'\nبرای جزئیات انتخاب کنید:',reply_markup:keyboard(buttons)});
  }
  async function drawDetail(chat,id) {
    if(!/^\d+$/.test(String(id)))return adminMessage({chat_id:chat,text:'شناسه قرعه‌کشی نامعتبر است.'});
    const [rows]=await db.execute(
      'SELECT d.id,d.winner_entry_id,d.winner_code,d.drawn_by,d.draw_seed,d.created_at,e.full_name,e.instagram,COUNT(p.entry_id) AS eligible_count FROM lottery_draws d LEFT JOIN lottery_entries e ON e.id=d.winner_entry_id LEFT JOIN lottery_draw_participants p ON p.draw_id=d.id WHERE d.id=? GROUP BY d.id,d.winner_entry_id,d.winner_code,d.drawn_by,d.draw_seed,d.created_at,e.full_name,e.instagram LIMIT 1',
      [id]
    );
    if(!rows.length)return adminMessage({chat_id:chat,text:'قرعه‌کشی پیدا نشد.'});
    const d=rows[0];
    return adminMessage({chat_id:chat,text:'🏆 جزئیات قرعه‌کشی #'+d.id+'\n\nبرنده: '+(d.full_name||'پرونده حذف‌شده')+'\nاینستاگرام: '+(d.instagram?'@'+d.instagram:'-')+'\nکد برنده: '+d.winner_code+'\nتعداد واجدان snapshot: '+d.eligible_count+'\nمدیر اجراکننده: '+d.drawn_by+'\nزمان: '+d.created_at+'\nSeed ثبت‌شده: '+d.draw_seed+'\n\nتوجه: seed فعلی به‌تنهایی اثبات مستقل و قابل راستی‌آزمایی انصاف قرعه‌کشی نیست.',reply_markup:keyboard([[{text:'↩️ تاریخچه',callback_data:'adm:draw-history:0'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]])});
  }
  async function drawPreview(chat) {
    if (await registrationOpen()) return adminMessage({chat_id:chat,text:'⛔ ابتدا ثبت‌نام را ببندید.'});
    const [[done]] = await db.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed'");
    if (done?.setting_value === 'true') return adminMessage({chat_id:chat,text:'⛔ قرعه‌کشی این دوره قبلاً انجام شده است.'});
    const [[count]] = await db.query("SELECT COUNT(*) total FROM lottery_entries WHERE status='active'");
    if (!Number(count.total)) return adminMessage({chat_id:chat,text:'شرکت‌کننده فعال وجود ندارد.'});
    return adminMessage({chat_id:chat,text:'⚠️ تأیید نهایی قرعه‌کشی\n\nتعداد واجدان فعلی: '+count.total+'\nپس از اجرا، نتیجه ثبت و قرعه‌کشی این دوره قفل می‌شود. این عملیات برگشت‌پذیر نیست.',reply_markup:keyboard([[{text:'🏆 بله، قرعه‌کشی کن',callback_data:'adm:confirm-draw'},{text:'انصراف',callback_data:'adm:home'}]])});
  }
  async function performDraw(chat) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[rs]] = await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='registration_open' FOR UPDATE");
      if (rs?.setting_value === 'true') throw new Error('ابتدا ثبت‌نام را ببندید.');
      await conn.execute("INSERT IGNORE INTO lottery_settings(setting_key,setting_value) VALUES('draw_completed','false')");
      const [[ds]] = await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed' FOR UPDATE");
      if (ds?.setting_value === 'true') throw new Error('قرعه‌کشی قبلاً انجام شده است.');
      const [people] = await conn.query("SELECT id,full_name,instagram,raffle_code FROM lottery_entries WHERE status='active' ORDER BY id FOR UPDATE");
      if (!people.length) throw new Error('شرکت‌کننده فعالی وجود ندارد.');
      const winner = people[crypto.randomInt(people.length)];
      const seed = crypto.randomBytes(32).toString('hex');
      const [d] = await conn.execute('INSERT INTO lottery_draws(winner_entry_id,winner_code,drawn_by,draw_seed) VALUES(?,?,?,?)',[winner.id,winner.raffle_code,String(adminId),seed]);
      for (const p of people) await conn.execute('INSERT INTO lottery_draw_participants(draw_id,entry_id,raffle_code) VALUES(?,?,?)',[d.insertId,p.id,p.raffle_code]);
      await conn.execute("UPDATE lottery_settings SET setting_value='true' WHERE setting_key='draw_completed'");
      await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),'draw','lottery_draw',String(d.insertId),JSON.stringify({eligible_count:people.length,winner_entry_id:winner.id,source:'telegram'})]);
      await conn.commit();
      return adminMessage({chat_id:chat,text:'🏆 قرعه‌کشی با موفقیت ثبت شد\n\nبرنده: '+winner.full_name+'\nاینستاگرام: @'+winner.instagram+'\nکد: '+winner.raffle_code+'\nتعداد واجدان: '+people.length+'\nشناسه قرعه‌کشی: '+d.insertId,reply_markup:keyboard([[{text:'↩️ منوی اصلی',callback_data:'adm:home'}]])});
    } catch (e) {
      await conn.rollback();
      return adminMessage({chat_id:chat,text:'❌ قرعه‌کشی انجام نشد: '+e.message});
    } finally { conn.release(); }
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
    if(!/^\\d+$/.test(String(id))) return adminMessage({chat_id:chat,text:'شناسه کمپین نامعتبر است.'});
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
    const buttons=campaignWizardFields.map((f,i)=>[{text:'✏️ '+(i+1)+'. '+f.label,callback_data:'adm:campaign-wizard-edit:'+i}]);
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
    if(data.startsWith('adm:card-status:')){const [, ,id,status]=data.split(':');if(!/^\\d+$/.test(id)||!['active','inactive'].includes(status))return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'});pending.set(String(adminId),{type:'card-status',id,status,expires:Date.now()+60000});return adminMessage({chat_id:chat,text:'تغییر وضعیت کارت را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید',callback_data:'adm:card-status-apply:'+id+':'+status},{text:'لغو',callback_data:'adm:card:'+id}]])});}
    if(data.startsWith('adm:card-status-apply:')){const [, ,id,status]=data.split(':');const p=pending.get(String(adminId));pending.delete(String(adminId));if(!p||p.type!=='card-status'||p.id!==id||p.status!==status||p.expires<Date.now())return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'});await bankCardService.setCardStatus(Number(id),status);await audit(status==='active'?'activate_bank_card':'deactivate_bank_card','bank_card',id,{source:'telegram'});return cardDetail(chat,id);}
    if(data.startsWith('adm:campaign-card-history:')){const id=data.slice('adm:campaign-card-history:'.length);if(!/^\\d+$/.test(id))return adminMessage({chat_id:chat,text:'شناسه کمپین نامعتبر است.'});const rows=await bankCardService.campaignHistory(Number(id));const body=rows.length?rows.map(r=>r.label+' · '+r.last4+'\nمدیر: '+r.changed_by+' · '+r.created_at+'\n'+(r.change_reason||'بدون توضیح')).join('\n\n'):'تاریخچه‌ای برای این کمپین ثبت نشده است.';return adminMessage({chat_id:chat,text:'🕘 تاریخچه کارت کمپین #'+id+'\n\n'+body,reply_markup:keyboard([[{text:'↩️ بازگشت به کمپین',callback_data:'adm:campaign-detail:'+id}]])});}
    if(data.startsWith('adm:campaign-card:'))return campaignCardPicker(chat,data.slice('adm:campaign-card:'.length));
    if(data.startsWith('adm:campaign-card-confirm:')){const [, ,campaignId,cardId]=data.split(':');if(!/^\\d+$/.test(campaignId)||!/^\\d+$/.test(cardId))return adminMessage({chat_id:chat,text:'درخواست نامعتبر است.'});pending.set(String(adminId),{type:'campaign-card',campaignId,cardId,expires:Date.now()+60000});const card=await bankCardService.getCard(Number(cardId),{activeOnly:true});return adminMessage({chat_id:chat,text:'تغییر کارت کمپین به «'+card.label+' · '+card.card_number.slice(-4)+'» را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید تغییر',callback_data:'adm:campaign-card-apply:'+campaignId+':'+cardId},{text:'لغو',callback_data:'adm:campaign-detail:'+campaignId}]])});}
    if(data.startsWith('adm:campaign-card-apply:')){const [, ,campaignId,cardId]=data.split(':');const p=pending.get(String(adminId));pending.delete(String(adminId));if(!p||p.type!=='campaign-card'||p.campaignId!==campaignId||p.cardId!==cardId||p.expires<Date.now())return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'});await bankCardService.assignCampaignCard(Number(campaignId),Number(cardId),'changed via Telegram admin panel');return campaignDetail(chat,campaignId);}
    if (data==='adm:home') return home(chat);
    if (data==='adm:stats') return stats(chat);
    if (data==='adm:reports') return campaignReports(chat);
    if (data==='adm:campaign') return campaign(chat);
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
      const id=data.slice('adm:order-resend:'.length);if(!/^\\d+$/.test(id))return adminMessage({chat_id:chat,text:'شناسه سفارش نامعتبر است.'});
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
    if (data==='adm:audit') return auditLog(chat);
    if (data==='adm:search') { searchModes.set(String(adminId),'search'); return adminMessage({chat_id:chat,text:'🔎 نام، شماره، آیدی اینستاگرام یا کد را ارسال کنید. برای لغو /cancel را بفرستید.'}); }
    if (data.startsWith('adm:entries:')) { const [, , page, status='all', period='all'] = data.split(':'); return entries(chat,page,status,period); }
    if (data.startsWith('adm:entry-status:')) { const period=data.slice('adm:entry-status:'.length); return adminMessage({chat_id:chat,text:'فیلتر وضعیت را انتخاب کنید:',reply_markup:keyboard([[{text:'همه',callback_data:'adm:entries:0:all:'+period},{text:'فعال',callback_data:'adm:entries:0:active:'+period},{text:'غیرفعال',callback_data:'adm:entries:0:inactive:'+period}],[{text:'لغو',callback_data:'adm:entries:0'}]])}); }
    if (data.startsWith('adm:entry-period:')) { const status=data.slice('adm:entry-period:'.length); return adminMessage({chat_id:chat,text:'بازه ثبت‌نام را انتخاب کنید:',reply_markup:keyboard([[{text:'همه',callback_data:'adm:entries:0:'+status+':all'},{text:'امروز',callback_data:'adm:entries:0:'+status+':today'}],[{text:'۷ روز اخیر',callback_data:'adm:entries:0:'+status+':7d'},{text:'۳۰ روز اخیر',callback_data:'adm:entries:0:'+status+':30d'}],[{text:'لغو',callback_data:'adm:entries:0'}]])}); }
    if (data.startsWith('adm:entry:')) return detail(chat,data.split(':')[2]);
    if (data.startsWith('adm:history:')) return history(chat,data.split(':')[2]);

    if (data.startsWith('adm:edit:')) {
      const id=data.slice(9);
      if(!/^\d+$/.test(id)) return adminMessage({chat_id:chat,text:'شناسه پرونده نامعتبر است.'});
      const [found]=await db.execute("SELECT id,full_name,phone,instagram,status FROM lottery_entries WHERE id=? LIMIT 1",[id]);
      if(!found.length||found[0].status==='deleted') return adminMessage({chat_id:chat,text:'پرونده پیدا نشد یا حذف شده است.'});
      editModes.set(String(adminId),{id,expires:Date.now()+300000});
      return adminMessage({chat_id:chat,text:'اطلاعات جدید را در یک پیام با قالب زیر بفرستید:\nنام و نام خانوادگی | شماره موبایل | آیدی اینستاگرام\nمثال: علی رضایی | 09123456789 | ali.rezaei\nبرای لغو /cancel را بفرستید.'});
    }
    if (data.startsWith('adm:delete:')) {
      const id=data.slice(11);
      if(!/^\d+$/.test(id)) return adminMessage({chat_id:chat,text:'شناسه پرونده نامعتبر است.'});
      const [found]=await db.execute("SELECT id,full_name,raffle_code,status FROM lottery_entries WHERE id=? LIMIT 1",[id]);
      if(!found.length||found[0].status==='deleted') return adminMessage({chat_id:chat,text:'پرونده پیدا نشد یا قبلاً حذف شده است.'});
      pending.set(String(adminId),{type:'delete',id,expires:Date.now()+60000});
      return adminMessage({chat_id:chat,text:'حذف منطقی این شرکت‌کننده را تأیید می‌کنید؟\n'+found[0].full_name+' · '+found[0].raffle_code+'\nکد آزاد نمی‌شود و تاریخچه حفظ می‌شود.',reply_markup:keyboard([[{text:'تأیید حذف',callback_data:'adm:apply-delete:'+id},{text:'لغو',callback_data:'adm:entry:'+id}]])});
    }
    if (data.startsWith('adm:apply-delete:')) {
      const id=data.slice(17),p=pending.get(String(adminId));pending.delete(String(adminId));
      if(!/^\d+$/.test(id)||!p||p.type!=='delete'||p.id!==id||p.expires<Date.now()) return adminMessage({chat_id:chat,text:'درخواست حذف منقضی یا نامعتبر است.'});
      const conn=await db.getConnection();
      try {
        await conn.beginTransaction();
        const [rows]=await conn.execute("SELECT id,status,raffle_code FROM lottery_entries WHERE id=? FOR UPDATE",[id]);
        if(!rows.length||rows[0].status==='deleted') throw new Error('پرونده پیدا نشد یا قبلاً حذف شده است.');
        await conn.execute("UPDATE lottery_entries SET status='deleted',deleted_at=NOW(),deletion_reason='حذف منطقی توسط مدیر تلگرام' WHERE id=?",[id]);
        await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),'delete_entry','lottery_entry',id,JSON.stringify({raffle_code:rows[0].raffle_code,source:'telegram'})]);
        await conn.commit();
      } catch(e) { await conn.rollback(); return adminMessage({chat_id:chat,text:'حذف انجام نشد: '+e.message}); }
      finally { conn.release(); }
      return detail(chat,id);
    }
    if (data.startsWith('adm:apply-edit:')) {
      const id=data.slice(15),p=pending.get(String(adminId));pending.delete(String(adminId));
      if(!/^\d+$/.test(id)||!p||p.type!=='edit'||p.id!==id||p.expires<Date.now()) return adminMessage({chat_id:chat,text:'درخواست ویرایش منقضی یا نامعتبر است.'});
      const conn=await db.getConnection();
      try {
        await conn.beginTransaction();
        const [oldRows]=await conn.execute("SELECT id,full_name,phone,instagram,status FROM lottery_entries WHERE id=? FOR UPDATE",[id]);
        if(!oldRows.length||oldRows[0].status==='deleted') throw new Error('پرونده پیدا نشد یا حذف شده است.');
        const [dups]=await conn.execute("SELECT id FROM lottery_entries WHERE status='active' AND id<>? AND (phone=? OR LOWER(instagram)=LOWER(?)) LIMIT 1",[id,p.phone,p.instagram]);
        if(dups.length) throw new Error('شماره یا آیدی اینستاگرام برای فرد فعال دیگری ثبت شده است.');
        await conn.execute("UPDATE lottery_entries SET full_name=?,phone=?,instagram=? WHERE id=?",[p.full_name,p.phone,p.instagram,id]);
        await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),'edit_entry','lottery_entry',id,JSON.stringify({source:'telegram',before:{full_name:oldRows[0].full_name,phone:oldRows[0].phone,instagram:oldRows[0].instagram},after:{full_name:p.full_name,phone:p.phone,instagram:p.instagram}})]);
        await conn.commit();
      } catch(e) { await conn.rollback(); return adminMessage({chat_id:chat,text:'ویرایش انجام نشد: '+e.message}); }
      finally { conn.release(); }
      return detail(chat,id);
    }
    if (data.startsWith('adm:confirm-status:')) {
      const [, , id, status] = data.split(':');
      pending.set(String(adminId),{type:'status',id,status,expires:Date.now()+60000});
      return adminMessage({chat_id:chat,text:'تغییر وضعیت شرکت‌کننده #'+id+' به '+status+' را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید',callback_data:'adm:apply-status:'+id+':'+status},{text:'لغو',callback_data:'adm:entry:'+id}]])});
    }
    if (data.startsWith('adm:apply-status:')) {
      const [, , id, status] = data.split(':');
      const p=pending.get(String(adminId)); pending.delete(String(adminId));
      if (!p||p.type!=='status'||p.id!==id||p.status!==status||p.expires<Date.now()) return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'});
      const conn=await db.getConnection();
      try {
        await conn.beginTransaction();
        const [current]=await conn.execute("SELECT id,status,phone,instagram FROM lottery_entries WHERE id=? FOR UPDATE",[id]);
        if(!current.length || current[0].status==='deleted') throw new Error('پرونده پیدا نشد یا حذف شده است.');
        if(current[0].status===status) throw new Error('وضعیت پرونده از قبل همین مقدار است.');
        if(status==='active') {
          const [dups]=await conn.execute("SELECT id FROM lottery_entries WHERE status='active' AND id<>? AND (phone=? OR LOWER(instagram)=LOWER(?)) LIMIT 1",[id,current[0].phone,current[0].instagram]);
          if(dups.length) throw new Error('شماره یا اینستاگرام با شرکت‌کننده فعال دیگری تکراری است.');
        }
        const [r]=await conn.execute("UPDATE lottery_entries SET status=? WHERE id=? AND status<>'deleted'",[status,id]);
        if(!r.affectedRows) throw new Error('پرونده پیدا نشد.');
        await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),status==='active'?'restore_entry':'deactivate_entry','lottery_entry',id,JSON.stringify({source:'telegram',from:current[0].status,to:status})]);
        await conn.commit();
      } catch(e) {
        await conn.rollback();
        return adminMessage({chat_id:chat,text:'تغییر وضعیت انجام نشد: '+e.message});
      } finally { conn.release(); }
      return detail(chat,id);
    }
    if (data.startsWith('adm:confirm-registration:')) {
      const value=data.endsWith(':true')?'true':'false';
      pending.set(String(adminId),{type:'registration',value,expires:Date.now()+60000});
      return adminMessage({chat_id:chat,text:value==='true'?'بازکردن ثبت‌نام را تأیید می‌کنید؟':'بستن ثبت‌نام را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید',callback_data:'adm:apply-registration:'+value},{text:'لغو',callback_data:'adm:campaign'}]])});
    }
    if (data.startsWith('adm:apply-registration:')) {
      const value=data.endsWith(':true')?'true':'false',p=pending.get(String(adminId));pending.delete(String(adminId));
      if(!p||p.type!=='registration'||p.value!==value||p.expires<Date.now()) return adminMessage({chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'});
      const conn=await db.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute("INSERT IGNORE INTO lottery_settings(setting_key,setting_value) VALUES('registration_open','false'),('draw_completed','false')");
        const [[d]]=await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed' FOR UPDATE");
        if(value==='true'&&d?.setting_value==='true') throw new Error('قرعه‌کشی این دوره انجام شده؛ کمپین جدید تعریف کنید.');
        await conn.execute("UPDATE lottery_settings SET setting_value=? WHERE setting_key='registration_open'",[value]);
        await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),value==='true'?'open_registration':'close_registration','lottery','current',JSON.stringify({source:'telegram',next:value})]);
        await conn.commit();
      } catch(e) { await conn.rollback(); return adminMessage({chat_id:chat,text:'❌ '+e.message}); }
      finally { conn.release(); }
      return campaign(chat);
    }
    if (data==='adm:draw') return adminMessage({chat_id:chat,text:'🏆 بخش قرعه‌کشی',reply_markup:keyboard([[{text:'اجرای قرعه‌کشی',callback_data:'adm:draw-run'},{text:'تاریخچه قرعه‌کشی',callback_data:'adm:draw-history:0'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]])});
    if (data==='adm:draw-run') return drawPreview(chat);
    if (data.startsWith('adm:draw-history:')) return drawHistory(chat,data.split(':')[2]);
    if (data.startsWith('adm:draw-detail:')) return drawDetail(chat,data.slice('adm:draw-detail:'.length));
    if (data==='adm:confirm-draw') return performDraw(chat);
    return adminMessage({chat_id:chat,text:'عملیات ناشناخته است.'});
  }
  async function handleCallback(q) {
    if (!isAdmin(q) || !String(q.data||'').startsWith('adm:')) return false;
    const callbackId=String(q.id||'');
    if(callbackId && completedCallbackIds.has(callbackId)) return true;
    if(callbackId && callbackInFlight.has(callbackId)) return callbackInFlight.get(callbackId);
    const actionKey=String(q.data||'');
    if(actionKey && actionInFlight.has(actionKey)) {
      try { await tg('answerCallbackQuery',{callback_query_id:q.id}); } catch (_) {}
      const shared=actionInFlight.get(actionKey);
      if(callbackId) callbackInFlight.set(callbackId,shared);
      try { return await shared; }
      finally { if(callbackId) callbackInFlight.delete(callbackId); }
    }
    const task=(async()=>{
      try { return await processCallback(q); }
      catch(error) {
        console.error('Admin callback failed:',error?.message||error);
        return adminMessage({chat_id:q.message.chat.id,text:'❌ عملیات انجام نشد. وضعیت داده‌ها را بررسی کنید و دوباره تلاش کنید.'});
      }
    })();
    if(callbackId) callbackInFlight.set(callbackId,task);
    if(actionKey) actionInFlight.set(actionKey,task);
    try {
      const result=await task;
      if(callbackId) {
        completedCallbackIds.add(callbackId);
        completedCallbackOrder.push(callbackId);
        if(completedCallbackOrder.length>2048) completedCallbackIds.delete(completedCallbackOrder.shift());
      }
      return result;
    } finally {
      if(callbackId) callbackInFlight.delete(callbackId);
      if(actionKey) actionInFlight.delete(actionKey);
    }
  }
  async function handleMessage(m) {
    if (!m?.from || String(m.from.id)!==String(adminId) || m.chat?.type!=='private') return false;
    const text=String(m.text||'').trim();
    if (text.toLowerCase().startsWith('/export')) { const parts=text.toLowerCase().split(/\s+/); return exportCsv(m.chat.id,parts[1]||'active',parts[2]||'all'); }
    if (text==='پنل'||text.toLowerCase()==='/panel'||text.toLowerCase()==='/start') { searchModes.delete(String(adminId)); return home(m.chat.id); }

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
    if (text.toLowerCase()==='/cancel' && (searchModes.has(String(adminId)) || editModes.has(String(adminId)) || pending.has(String(adminId)))) { searchModes.delete(String(adminId)); editModes.delete(String(adminId)); pending.delete(String(adminId)); return home(m.chat.id,'عملیات لغو شد.'); }
    if (editModes.has(String(adminId)) && text) {
      const mode=editModes.get(String(adminId)); editModes.delete(String(adminId));
      if(mode.expires<Date.now()) return adminMessage({chat_id:m.chat.id,text:'مهلت ویرایش تمام شده است؛ دوباره از پرونده اقدام کنید.'});
      const parts=text.split('|').map(x=>x.trim());
      if(parts.length!==3) return adminMessage({chat_id:m.chat.id,text:'قالب نادرست است. سه مقدار را با | جدا کنید.'});
      const full_name=parts[0].replace(/\s+/g,' '),phone=normalizePhone(digits(parts[1])),instagram=normalizeInstagram(parts[2]);
      if(!validFullName(full_name)||!validPhone(phone)||!validInstagram(instagram)) return adminMessage({chat_id:m.chat.id,text:'اطلاعات نامعتبر است؛ نام، شماره و آیدی را بررسی کنید.'});
      const [rows]=await db.execute('SELECT id,status FROM lottery_entries WHERE id=? LIMIT 1',[mode.id]);
      if(!rows.length||rows[0].status==='deleted') return adminMessage({chat_id:m.chat.id,text:'پرونده پیدا نشد یا حذف شده است.'});
      pending.set(String(adminId),{type:'edit',id:mode.id,full_name,phone,instagram,expires:Date.now()+60000});
      return adminMessage({chat_id:m.chat.id,text:'پیش‌نمایش ویرایش:\nنام: '+full_name+'\nموبایل: '+phone+'\nاینستاگرام: @'+instagram+'\n\nثبت تغییرات؟',reply_markup:keyboard([[{text:'تأیید و ثبت',callback_data:'adm:apply-edit:'+mode.id},{text:'لغو',callback_data:'adm:entry:'+mode.id}]])});
    }
    if (!searchModes.has(String(adminId)) || !text) return false;
    searchModes.delete(String(adminId));
    const term=digits(text).slice(0,100);
    const [rows]=await db.execute("SELECT id,full_name,phone,instagram,raffle_code,status FROM lottery_entries WHERE (?='' OR full_name LIKE ? OR phone LIKE ? OR instagram LIKE ? OR raffle_code LIKE ? OR telegram_user_id=?) ORDER BY id DESC LIMIT 10",[term,'%'+term+'%','%'+term+'%','%'+term+'%','%'+term+'%',term]);
    if(!rows.length) return adminMessage({chat_id:m.chat.id,text:'نتیجه‌ای پیدا نشد.',reply_markup:keyboard([[{text:'🔎 جستجوی دوباره',callback_data:'adm:search'},{text:'🏠 منو',callback_data:'adm:home'}]])});
    const buttons=rows.map(x=>[{text:(x.status==='active'?'✅ ':'⏸ ')+x.full_name+' · '+x.raffle_code,callback_data:'adm:entry:'+x.id}]);
    buttons.push([{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    return adminMessage({chat_id:m.chat.id,text:'🔎 نتایج جستجو: '+rows.length,reply_markup:keyboard(buttons)});
  }
  return { handleCallback, handleMessage };
}
module.exports = { createAdminTelegram };
