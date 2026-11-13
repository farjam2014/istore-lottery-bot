'use strict';
const crypto = require('node:crypto');
const { normalizePhone, validPhone, normalizeInstagram, validInstagram, validFullName } = require('./domain');

function createAdminTelegram({ db, tg: sendTelegram, tgDocument, adminId, registrationOpen }) {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const callbackMessage = new AsyncLocalStorage();
  async function tg(method, payload) {
    const target = callbackMessage.getStore();
    if (method === 'sendMessage' && target && String(payload.chat_id) === String(target.chatId)) {
      try {
        return await sendTelegram('editMessageText', {
          chat_id: target.chatId,
          message_id: target.messageId,
          text: payload.text,
          ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
          ...(payload.parse_mode ? { parse_mode: payload.parse_mode } : {}),
          ...(payload.link_preview_options ? { link_preview_options: payload.link_preview_options } : {})
        });
      } catch (error) {
        const message = String(error?.description || error?.message || '');
        if (/message is not modified/i.test(message)) return { ok: true, result: { message_id: target.messageId } };
        if (!/message to edit not found|message can't be edited|message_id_invalid|there is no text in the message/i.test(message)) throw error;
      }
    }
    return sendTelegram(method, payload);
  }
  const searchModes = new Map();
  const editModes = new Map();
  const pending = new Map();
  const isAdmin = (q) => String(q?.from?.id || '') === String(adminId) && q?.message?.chat?.type === 'private';
  const menu = [
    [{ text: '📊 داشبورد', callback_data: 'adm:stats' }, { text: '👥 شرکت‌کنندگان', callback_data: 'adm:entries:0' }],
    [{ text: '🎟 کدها و خروجی', callback_data: 'adm:export' }, { text: '⚙️ کمپین', callback_data: 'adm:campaign' }],
    [{ text: '🏆 قرعه‌کشی', callback_data: 'adm:draw' }, { text: '🧾 رخدادها', callback_data: 'adm:audit' }],
    [{ text: '🔎 جستجو', callback_data: 'adm:search' }, { text: '🔄 تازه‌سازی', callback_data: 'adm:home' }]
  ];
  const keyboard = (rows) => ({ inline_keyboard: rows });
  const home = (chat, text = '🛠 مدیریت iStore\nیک بخش را انتخاب کنید:') =>
    tg('sendMessage', { chat_id: chat, text, reply_markup: keyboard(menu) });
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
    const [[a]] = await db.query("SELECT COUNT(*) total, SUM(status='active') active, SUM(status='inactive') inactive, SUM(status='deleted') deleted FROM lottery_entries");
    const [[b]] = await db.query("SELECT COUNT(*) today FROM lottery_entries WHERE status='active' AND DATE(created_at)=CURDATE()");
    const [[s]] = await db.query("SELECT COUNT(*) pending FROM lottery_sessions");
    const [[f]] = await db.query("SELECT COUNT(*) failed FROM webhook_inbox WHERE status='failed'");
    const [[d]] = await db.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed'");
    return tg('sendMessage', { chat_id: chat, text:
      '📊 داشبورد قرعه‌کشی iStore\n\n' +
      '👥 کل پرونده‌ها: ' + Number(a.total || 0) +
      '\n✅ فعال: ' + Number(a.active || 0) +
      '\n⏸ غیرفعال: ' + Number(a.inactive || 0) +
      '\n🗑 حذف منطقی: ' + Number(a.deleted || 0) +
      '\n📅 ثبت‌نام امروز: ' + Number(b.today || 0) +
      '\n⌛ نشست‌های نیمه‌کاره: ' + Number(s.pending || 0) +
      '\n⚠️ webhook ناموفق: ' + Number(f.failed || 0) +
      '\n🏆 قرعه‌کشی: ' + (d?.setting_value === 'true' ? 'انجام شده' : 'انجام نشده'),
      reply_markup: keyboard([[{text:'↩️ منوی اصلی',callback_data:'adm:home'}]]) });
  }
  async function entries(chat, page, status = 'all', period = 'all') {
    const p = Math.max(0, Math.min(10000, Number(page) || 0));
    if (!['all','active','inactive'].includes(status) || !['all','today','7d','30d'].includes(period)) {
      return tg('sendMessage', { chat_id: chat, text: 'فیلتر نامعتبر است.' });
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
    return tg('sendMessage', { chat_id: chat, text: '👥 شرکت‌کنندگان · صفحه ' + (p + 1) + '\nبرای مشاهده جزئیات یک نفر را انتخاب کنید:', reply_markup: keyboard(buttons) });
  }
  async function detail(chat, id) {
    const [rows] = await db.execute('SELECT id,full_name,phone,instagram,raffle_code,status,created_at,updated_at,deletion_reason FROM lottery_entries WHERE id=? LIMIT 1', [id]);
    if (!rows.length) return tg('sendMessage', { chat_id: chat, text: 'شرکت‌کننده پیدا نشد.' });
    const x = rows[0];
    const [hist] = await db.execute('SELECT raffle_code,action,actor,created_at FROM lottery_code_history WHERE entry_id=? ORDER BY id DESC LIMIT 5', [id]);
    const history = hist.length ? hist.map(h => h.action + ' · ' + h.raffle_code + ' · ' + h.actor).join('\n') : 'بدون سابقه کد';
    const rowsKb = [[{text:'📝 تاریخچه کد',callback_data:'adm:history:'+id}]];
    if (x.status !== 'deleted') {
      rowsKb.push([{text:'✏️ ویرایش اطلاعات',callback_data:'adm:edit:'+id},{text:'🗑 حذف منطقی',callback_data:'adm:delete:'+id}]);
      rowsKb.push([{text:x.status === 'active' ? '⏸ غیرفعال‌سازی' : '✅ فعال‌سازی',callback_data:'adm:confirm-status:'+id+':'+(x.status === 'active' ? 'inactive' : 'active')}]);
    }
    rowsKb.push([{text:'👥 فهرست',callback_data:'adm:entries:0'},{text:'↩️ منوی اصلی',callback_data:'adm:home'}]);
    return tg('sendMessage', { chat_id: chat, text:
      '👤 پرونده شرکت‌کننده #' + x.id + '\n\nنام: ' + x.full_name +
      '\nموبایل: ' + x.phone + '\nاینستاگرام: @' + x.instagram +
      '\nکد: ' + x.raffle_code + '\nوضعیت: ' + x.status +
      '\nثبت: ' + x.created_at + '\n\nآخرین سوابق کد:\n' + history,
      reply_markup: keyboard(rowsKb) });
  }
  async function history(chat, id) {
    const [rows] = await db.execute('SELECT raffle_code,action,actor,created_at FROM lottery_code_history WHERE entry_id=? ORDER BY id DESC LIMIT 30', [id]);
    const body = rows.length ? rows.map((x,i) => (i+1)+') '+x.action+' | '+x.raffle_code+' | '+x.actor+' | '+x.created_at).join('\n') : 'سابقه‌ای ثبت نشده است.';
    return tg('sendMessage', { chat_id: chat, text: '🧾 تاریخچه کدها\n\n'+body, reply_markup: keyboard([[{text:'↩️ پرونده',callback_data:'adm:entry:'+id}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]]) });
  }
  async function campaign(chat) {
    const open = await registrationOpen();
    const [[draw]] = await db.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed'");
    return tg('sendMessage', { chat_id: chat, text:
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
      return tg('sendMessage',{chat_id:chat,text:'فیلتر خروجی نامعتبر است.'});
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
    return tg('sendMessage',{chat_id:chat,text:'فیلتر خروجی CSV را انتخاب کنید:',reply_markup:keyboard([
      [{text:'همه وضعیت‌ها',callback_data:'adm:export:all'},{text:'فعال‌ها',callback_data:'adm:export:active'}],
      [{text:'غیرفعال‌ها',callback_data:'adm:export:inactive'}],
      [{text:'راهنما و بازه زمانی',callback_data:'adm:export:help'}],
      [{text:'منوی اصلی',callback_data:'adm:home'}]
    ])});
  }
  async function auditLog(chat) {
    const [rows] = await db.query('SELECT action,entity_type,entity_id,created_at FROM admin_audit_log ORDER BY id DESC LIMIT 15');
    const body = rows.length ? rows.map((x,i)=>(i+1)+') '+x.action+' · '+x.entity_type+' #'+(x.entity_id||'-')+'\n'+x.created_at).join('\n\n') : 'هنوز رخدادی ثبت نشده است.';
    return tg('sendMessage',{chat_id:chat,text:'🧾 ۱۵ رخداد اخیر\n\n'+body,reply_markup:keyboard([[{text:'↩️ منوی اصلی',callback_data:'adm:home'}]])});
  }
  async function drawHistory(chat, page = 0) {
    const p = Math.max(0, Math.min(10000, Number(page) || 0));
    const [rows] = await db.execute(
      'SELECT d.id,d.winner_entry_id,d.winner_code,d.drawn_by,d.created_at,COUNT(p.entry_id) AS eligible_count FROM lottery_draws d LEFT JOIN lottery_draw_participants p ON p.draw_id=d.id GROUP BY d.id,d.winner_entry_id,d.winner_code,d.drawn_by,d.created_at ORDER BY d.id DESC LIMIT 8 OFFSET ?',
      [p * 8]
    );
    if (!rows.length && p === 0) return tg('sendMessage',{chat_id:chat,text:'هنوز قرعه‌کشی ثبت‌شده‌ای وجود ندارد.',reply_markup:keyboard([[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]])});
    const buttons = rows.map(x => [{text:'🏆 قرعه‌کشی #'+x.id+' · '+x.winner_code,callback_data:'adm:draw-detail:'+x.id}]);
    const nav=[];
    if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'adm:draw-history:'+(p-1)});
    if(rows.length===8)nav.push({text:'بعدی ➡️',callback_data:'adm:draw-history:'+(p+1)});
    if(nav.length)buttons.push(nav);
    buttons.push([{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    return tg('sendMessage',{chat_id:chat,text:'📚 تاریخچه قرعه‌کشی · صفحه '+(p+1)+'\nبرای جزئیات انتخاب کنید:',reply_markup:keyboard(buttons)});
  }
  async function drawDetail(chat,id) {
    if(!/^\\d+$/.test(String(id)))return tg('sendMessage',{chat_id:chat,text:'شناسه قرعه‌کشی نامعتبر است.'});
    const [rows]=await db.execute(
      'SELECT d.id,d.winner_entry_id,d.winner_code,d.drawn_by,d.draw_seed,d.created_at,e.full_name,e.instagram,COUNT(p.entry_id) AS eligible_count FROM lottery_draws d LEFT JOIN lottery_entries e ON e.id=d.winner_entry_id LEFT JOIN lottery_draw_participants p ON p.draw_id=d.id WHERE d.id=? GROUP BY d.id,d.winner_entry_id,d.winner_code,d.drawn_by,d.draw_seed,d.created_at,e.full_name,e.instagram LIMIT 1',
      [id]
    );
    if(!rows.length)return tg('sendMessage',{chat_id:chat,text:'قرعه‌کشی پیدا نشد.'});
    const d=rows[0];
    return tg('sendMessage',{chat_id:chat,text:'🏆 جزئیات قرعه‌کشی #'+d.id+'\n\nبرنده: '+(d.full_name||'پرونده حذف‌شده')+'\nاینستاگرام: '+(d.instagram?'@'+d.instagram:'-')+'\nکد برنده: '+d.winner_code+'\nتعداد واجدان snapshot: '+d.eligible_count+'\nمدیر اجراکننده: '+d.drawn_by+'\nزمان: '+d.created_at+'\nSeed ثبت‌شده: '+d.draw_seed+'\n\nتوجه: seed فعلی به‌تنهایی اثبات مستقل و قابل راستی‌آزمایی انصاف قرعه‌کشی نیست.',reply_markup:keyboard([[{text:'↩️ تاریخچه',callback_data:'adm:draw-history:0'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]])});
  }
  async function drawPreview(chat) {
    if (await registrationOpen()) return tg('sendMessage',{chat_id:chat,text:'⛔ ابتدا ثبت‌نام را ببندید.'});
    const [[done]] = await db.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed'");
    if (done?.setting_value === 'true') return tg('sendMessage',{chat_id:chat,text:'⛔ قرعه‌کشی این دوره قبلاً انجام شده است.'});
    const [[count]] = await db.query("SELECT COUNT(*) total FROM lottery_entries WHERE status='active'");
    if (!Number(count.total)) return tg('sendMessage',{chat_id:chat,text:'شرکت‌کننده فعال وجود ندارد.'});
    return tg('sendMessage',{chat_id:chat,text:'⚠️ تأیید نهایی قرعه‌کشی\n\nتعداد واجدان فعلی: '+count.total+'\nپس از اجرا، نتیجه ثبت و قرعه‌کشی این دوره قفل می‌شود. این عملیات برگشت‌پذیر نیست.',reply_markup:keyboard([[{text:'🏆 بله، قرعه‌کشی کن',callback_data:'adm:confirm-draw'},{text:'انصراف',callback_data:'adm:home'}]])});
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
      return tg('sendMessage',{chat_id:chat,text:'🏆 قرعه‌کشی با موفقیت ثبت شد\n\nبرنده: '+winner.full_name+'\nاینستاگرام: @'+winner.instagram+'\nکد: '+winner.raffle_code+'\nتعداد واجدان: '+people.length+'\nشناسه قرعه‌کشی: '+d.insertId,reply_markup:keyboard([[{text:'↩️ منوی اصلی',callback_data:'adm:home'}]])});
    } catch (e) {
      await conn.rollback();
      return tg('sendMessage',{chat_id:chat,text:'❌ قرعه‌کشی انجام نشد: '+e.message});
    } finally { conn.release(); }
  }
  async function handleCallback(q) {
    if (!isAdmin(q) || !String(q.data||'').startsWith('adm:')) return false;
    const chat = q.message.chat.id, data = q.data;
    await tg('answerCallbackQuery',{callback_query_id:q.id});
    return callbackMessage.run({ chatId: chat, messageId: q.message.message_id }, async () => {
    if (data==='adm:home') return home(chat);
    if (data==='adm:stats') return stats(chat);
    if (data==='adm:campaign') return campaign(chat);
    if (data==='adm:export') return exportMenu(chat);
    if (data==='adm:export:help') return tg('sendMessage',{chat_id:chat,text:'برای خروجی فیلترشده از دستورهای زیر استفاده کن:\n/export active today\n/export all 7d\n/export inactive 30d\n\nمقادیر وضعیت: all, active, inactive و بازه: all, today, 7d, 30d'});
    if (data.startsWith('adm:export:')) return exportCsv(chat,data.slice('adm:export:'.length),'all');
    if (data==='adm:audit') return auditLog(chat);
    if (data==='adm:search') { searchModes.set(String(adminId),'search'); return tg('sendMessage',{chat_id:chat,text:'🔎 نام، شماره، آیدی اینستاگرام یا کد را ارسال کنید. برای لغو /cancel را بفرستید.'}); }
    if (data.startsWith('adm:entries:')) { const [, , page, status='all', period='all'] = data.split(':'); return entries(chat,page,status,period); }
    if (data.startsWith('adm:entry-status:')) { const period=data.slice('adm:entry-status:'.length); return tg('sendMessage',{chat_id:chat,text:'فیلتر وضعیت را انتخاب کنید:',reply_markup:keyboard([[{text:'همه',callback_data:'adm:entries:0:all:'+period},{text:'فعال',callback_data:'adm:entries:0:active:'+period},{text:'غیرفعال',callback_data:'adm:entries:0:inactive:'+period}],[{text:'لغو',callback_data:'adm:entries:0'}]])}); }
    if (data.startsWith('adm:entry-period:')) { const status=data.slice('adm:entry-period:'.length); return tg('sendMessage',{chat_id:chat,text:'بازه ثبت‌نام را انتخاب کنید:',reply_markup:keyboard([[{text:'همه',callback_data:'adm:entries:0:'+status+':all'},{text:'امروز',callback_data:'adm:entries:0:'+status+':today'}],[{text:'۷ روز اخیر',callback_data:'adm:entries:0:'+status+':7d'},{text:'۳۰ روز اخیر',callback_data:'adm:entries:0:'+status+':30d'}],[{text:'لغو',callback_data:'adm:entries:0'}]])}); }
    if (data.startsWith('adm:entry:')) return detail(chat,data.split(':')[2]);
    if (data.startsWith('adm:history:')) return history(chat,data.split(':')[2]);

    if (data.startsWith('adm:edit:')) {
      const id=data.slice(9);
      if(!/^\d+$/.test(id)) return tg('sendMessage',{chat_id:chat,text:'شناسه پرونده نامعتبر است.'});
      const [found]=await db.execute("SELECT id,full_name,phone,instagram,status FROM lottery_entries WHERE id=? LIMIT 1",[id]);
      if(!found.length||found[0].status==='deleted') return tg('sendMessage',{chat_id:chat,text:'پرونده پیدا نشد یا حذف شده است.'});
      editModes.set(String(adminId),{id,expires:Date.now()+300000});
      return tg('sendMessage',{chat_id:chat,text:'اطلاعات جدید را در یک پیام با قالب زیر بفرستید:\nنام و نام خانوادگی | شماره موبایل | آیدی اینستاگرام\nمثال: علی رضایی | 09123456789 | ali.rezaei\nبرای لغو /cancel را بفرستید.'});
    }
    if (data.startsWith('adm:delete:')) {
      const id=data.slice(11);
      if(!/^\d+$/.test(id)) return tg('sendMessage',{chat_id:chat,text:'شناسه پرونده نامعتبر است.'});
      const [found]=await db.execute("SELECT id,full_name,raffle_code,status FROM lottery_entries WHERE id=? LIMIT 1",[id]);
      if(!found.length||found[0].status==='deleted') return tg('sendMessage',{chat_id:chat,text:'پرونده پیدا نشد یا قبلاً حذف شده است.'});
      pending.set(String(adminId),{type:'delete',id,expires:Date.now()+60000});
      return tg('sendMessage',{chat_id:chat,text:'حذف منطقی این شرکت‌کننده را تأیید می‌کنید؟\n'+found[0].full_name+' · '+found[0].raffle_code+'\nکد آزاد نمی‌شود و تاریخچه حفظ می‌شود.',reply_markup:keyboard([[{text:'تأیید حذف',callback_data:'adm:apply-delete:'+id},{text:'لغو',callback_data:'adm:entry:'+id}]])});
    }
    if (data.startsWith('adm:apply-delete:')) {
      const id=data.slice(17),p=pending.get(String(adminId));pending.delete(String(adminId));
      if(!/^\d+$/.test(id)||!p||p.type!=='delete'||p.id!==id||p.expires<Date.now()) return tg('sendMessage',{chat_id:chat,text:'درخواست حذف منقضی یا نامعتبر است.'});
      const conn=await db.getConnection();
      try {
        await conn.beginTransaction();
        const [rows]=await conn.execute("SELECT id,status,raffle_code FROM lottery_entries WHERE id=? FOR UPDATE",[id]);
        if(!rows.length||rows[0].status==='deleted') throw new Error('پرونده پیدا نشد یا قبلاً حذف شده است.');
        await conn.execute("UPDATE lottery_entries SET status='deleted',deleted_at=NOW(),deletion_reason='حذف منطقی توسط مدیر تلگرام' WHERE id=?",[id]);
        await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),'delete_entry','lottery_entry',id,JSON.stringify({raffle_code:rows[0].raffle_code,source:'telegram'})]);
        await conn.commit();
      } catch(e) { await conn.rollback(); return tg('sendMessage',{chat_id:chat,text:'حذف انجام نشد: '+e.message}); }
      finally { conn.release(); }
      return detail(chat,id);
    }
    if (data.startsWith('adm:apply-edit:')) {
      const id=data.slice(15),p=pending.get(String(adminId));pending.delete(String(adminId));
      if(!/^\d+$/.test(id)||!p||p.type!=='edit'||p.id!==id||p.expires<Date.now()) return tg('sendMessage',{chat_id:chat,text:'درخواست ویرایش منقضی یا نامعتبر است.'});
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
      } catch(e) { await conn.rollback(); return tg('sendMessage',{chat_id:chat,text:'ویرایش انجام نشد: '+e.message}); }
      finally { conn.release(); }
      return detail(chat,id);
    }
    if (data.startsWith('adm:confirm-status:')) {
      const [, , id, status] = data.split(':');
      pending.set(String(adminId),{type:'status',id,status,expires:Date.now()+60000});
      return tg('sendMessage',{chat_id:chat,text:'تغییر وضعیت شرکت‌کننده #'+id+' به '+status+' را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید',callback_data:'adm:apply-status:'+id+':'+status},{text:'لغو',callback_data:'adm:entry:'+id}]])});
    }
    if (data.startsWith('adm:apply-status:')) {
      const [, , id, status] = data.split(':');
      const p=pending.get(String(adminId)); pending.delete(String(adminId));
      if (!p||p.type!=='status'||p.id!==id||p.status!==status||p.expires<Date.now()) return tg('sendMessage',{chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'});
      if (status==='active') {
        const [dups]=await db.execute("SELECT id FROM lottery_entries WHERE status='active' AND id<>? AND (phone=(SELECT phone FROM lottery_entries WHERE id=?) OR LOWER(instagram)=(SELECT LOWER(instagram) FROM lottery_entries WHERE id=?)) LIMIT 1",[id,id,id]);
        if(dups.length) return tg('sendMessage',{chat_id:chat,text:'شماره یا اینستاگرام با شرکت‌کننده فعال دیگری تکراری است.'});
      }
      const [r]=await db.execute("UPDATE lottery_entries SET status=? WHERE id=? AND status<>'deleted'",[status,id]);
      if(!r.affectedRows) return tg('sendMessage',{chat_id:chat,text:'پرونده پیدا نشد.'});
      await audit(status==='active'?'restore_entry':'deactivate_entry','lottery_entry',id,{source:'telegram'});
      return detail(chat,id);
    }
    if (data.startsWith('adm:confirm-registration:')) {
      const value=data.endsWith(':true')?'true':'false';
      pending.set(String(adminId),{type:'registration',value,expires:Date.now()+60000});
      return tg('sendMessage',{chat_id:chat,text:value==='true'?'بازکردن ثبت‌نام را تأیید می‌کنید؟':'بستن ثبت‌نام را تأیید می‌کنید؟',reply_markup:keyboard([[{text:'تأیید',callback_data:'adm:apply-registration:'+value},{text:'لغو',callback_data:'adm:campaign'}]])});
    }
    if (data.startsWith('adm:apply-registration:')) {
      const value=data.endsWith(':true')?'true':'false',p=pending.get(String(adminId));pending.delete(String(adminId));
      if(!p||p.type!=='registration'||p.value!==value||p.expires<Date.now()) return tg('sendMessage',{chat_id:chat,text:'درخواست منقضی یا نامعتبر است.'});
      const conn=await db.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute("INSERT IGNORE INTO lottery_settings(setting_key,setting_value) VALUES('registration_open','false'),('draw_completed','false')");
        const [[d]]=await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed' FOR UPDATE");
        if(value==='true'&&d?.setting_value==='true') throw new Error('قرعه‌کشی این دوره انجام شده؛ کمپین جدید تعریف کنید.');
        await conn.execute("UPDATE lottery_settings SET setting_value=? WHERE setting_key='registration_open'",[value]);
        await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),value==='true'?'open_registration':'close_registration','lottery','current',JSON.stringify({source:'telegram',next:value})]);
        await conn.commit();
      } catch(e) { await conn.rollback(); return tg('sendMessage',{chat_id:chat,text:'❌ '+e.message}); }
      finally { conn.release(); }
      return campaign(chat);
    }
    if (data==='adm:draw') return tg('sendMessage',{chat_id:chat,text:'🏆 بخش قرعه‌کشی',reply_markup:keyboard([[{text:'اجرای قرعه‌کشی',callback_data:'adm:draw-run'},{text:'تاریخچه قرعه‌کشی',callback_data:'adm:draw-history:0'}],[{text:'🏠 منوی اصلی',callback_data:'adm:home'}]])});
    if (data==='adm:draw-run') return drawPreview(chat);
    if (data.startsWith('adm:draw-history:')) return drawHistory(chat,data.split(':')[2]);
    if (data.startsWith('adm:draw-detail:')) return drawDetail(chat,data.slice('adm:draw-detail:'.length));
    if (data==='adm:confirm-draw') return performDraw(chat);
    return tg('sendMessage',{chat_id:chat,text:'عملیات ناشناخته است.'});
    });
  }
  async function handleMessage(m) {
    if (!m?.from || String(m.from.id)!==String(adminId) || m.chat?.type!=='private') return false;
    const text=String(m.text||'').trim();
    if (text.toLowerCase().startsWith('/export')) { const parts=text.toLowerCase().split(/\s+/); return exportCsv(m.chat.id,parts[1]||'active',parts[2]||'all'); }
    if (text==='پنل'||text.toLowerCase()==='/panel'||text.toLowerCase()==='/start') { searchModes.delete(String(adminId)); return home(m.chat.id); }

    if (text.toLowerCase()==='/cancel' && (searchModes.has(String(adminId)) || editModes.has(String(adminId)) || pending.has(String(adminId)))) { searchModes.delete(String(adminId)); editModes.delete(String(adminId)); pending.delete(String(adminId)); return home(m.chat.id,'عملیات لغو شد.'); }
    if (editModes.has(String(adminId)) && text) {
      const mode=editModes.get(String(adminId)); editModes.delete(String(adminId));
      if(mode.expires<Date.now()) return tg('sendMessage',{chat_id:m.chat.id,text:'مهلت ویرایش تمام شده است؛ دوباره از پرونده اقدام کنید.'});
      const parts=text.split('|').map(x=>x.trim());
      if(parts.length!==3) return tg('sendMessage',{chat_id:m.chat.id,text:'قالب نادرست است. سه مقدار را با | جدا کنید.'});
      const full_name=parts[0].replace(/\s+/g,' '),phone=normalizePhone(digits(parts[1])),instagram=normalizeInstagram(parts[2]);
      if(!validFullName(full_name)||!validPhone(phone)||!validInstagram(instagram)) return tg('sendMessage',{chat_id:m.chat.id,text:'اطلاعات نامعتبر است؛ نام، شماره و آیدی را بررسی کنید.'});
      const [rows]=await db.execute('SELECT id,status FROM lottery_entries WHERE id=? LIMIT 1',[mode.id]);
      if(!rows.length||rows[0].status==='deleted') return tg('sendMessage',{chat_id:m.chat.id,text:'پرونده پیدا نشد یا حذف شده است.'});
      pending.set(String(adminId),{type:'edit',id:mode.id,full_name,phone,instagram,expires:Date.now()+60000});
      return tg('sendMessage',{chat_id:m.chat.id,text:'پیش‌نمایش ویرایش:\nنام: '+full_name+'\nموبایل: '+phone+'\nاینستاگرام: @'+instagram+'\n\nثبت تغییرات؟',reply_markup:keyboard([[{text:'تأیید و ثبت',callback_data:'adm:apply-edit:'+mode.id},{text:'لغو',callback_data:'adm:entry:'+mode.id}]])});
    }
    if (!searchModes.has(String(adminId)) || !text) return false;
    searchModes.delete(String(adminId));
    const term=digits(text).slice(0,100);
    const [rows]=await db.execute("SELECT id,full_name,phone,instagram,raffle_code,status FROM lottery_entries WHERE (?='' OR full_name LIKE ? OR phone LIKE ? OR instagram LIKE ? OR raffle_code LIKE ? OR telegram_user_id=?) ORDER BY id DESC LIMIT 10",[term,'%'+term+'%','%'+term+'%','%'+term+'%','%'+term+'%',term]);
    if(!rows.length) return tg('sendMessage',{chat_id:m.chat.id,text:'نتیجه‌ای پیدا نشد.',reply_markup:keyboard([[{text:'🔎 جستجوی دوباره',callback_data:'adm:search'},{text:'🏠 منو',callback_data:'adm:home'}]])});
    const buttons=rows.map(x=>[{text:(x.status==='active'?'✅ ':'⏸ ')+x.full_name+' · '+x.raffle_code,callback_data:'adm:entry:'+x.id}]);
    buttons.push([{text:'🏠 منوی اصلی',callback_data:'adm:home'}]);
    return tg('sendMessage',{chat_id:m.chat.id,text:'🔎 نتایج جستجو: '+rows.length,reply_markup:keyboard(buttons)});
  }
  return { handleCallback, handleMessage };
}
module.exports = { createAdminTelegram };
