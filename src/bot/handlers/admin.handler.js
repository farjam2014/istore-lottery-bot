import {randomBytes} from 'node:crypto';
import {config} from '../../config/env.js';
import {pool} from '../../database/pool.js';
import {Markup} from 'telegraf';
import {listPendingReceipts} from '../../modules/payments/payment.service.js';
import {toCsv} from '../../shared/csv.js';
import {hasPermission,isConfiguredSuperAdmin} from '../../modules/admin/admin-role.service.js';

const isAdmin=ctx=>config.adminIds.has(String(ctx.from?.id));
const can=async(ctx,permission)=>hasPermission(ctx.from?.id,permission);
const deny=ctx=>ctx.answerCbQuery('برای این عملیات مجوز ندارید.',{show_alert:true});
const menu=()=>Markup.inlineKeyboard([
  [Markup.button.callback('🎯 مدیریت کمپین‌ها','admin:campaigns')],
  [Markup.button.callback('👥 مدیریت شرکت‌کنندگان','admin:participants')],
  [Markup.button.callback('💬 تیکت‌های پشتیبانی','admin:support')],
  [Markup.button.callback('🛡 مدیریت مدیران و نقش‌ها','admin:roles')],
  [Markup.button.callback('📊 آمار کاربران','admin:stats')],
  [Markup.button.callback('🧾 رسیدهای پرداخت','admin:payments')],
  [Markup.button.callback('💳 تنظیم کارت بانکی','admin:payment-settings')]
]);
const campaignMenu=()=>Markup.inlineKeyboard([
  [Markup.button.callback('➕ افزودن کمپین','admin:campaign:add')],
  [Markup.button.callback('📋 فهرست کمپین‌ها','admin:campaign:list')],
  [Markup.button.callback('↩️ بازگشت به مدیریت','admin:home')]
]);
const typeMenu=(selected=null)=>Markup.inlineKeyboard([
  [Markup.button.callback((selected==='free'?'🔘 ':'🟢 ')+'رایگان','admin:campaign:type:free')],
  [Markup.button.callback((selected==='paid'?'🔘 ':'💳 ')+'پولی','admin:campaign:type:paid')],
  [Markup.button.callback('ادامه','admin:campaign:continue')],
  [Markup.button.callback('لغو','admin:campaign:cancel')]
]);
async function getWizard(id){const [r]=await pool.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=?',[String(id)]);if(!r[0])return null;return {step:r[0].step,payload:typeof r[0].payload==='string'?JSON.parse(r[0].payload):r[0].payload};}
async function saveWizard(id,step,payload){await pool.execute('INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,?,?) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)',[String(id),step,JSON.stringify(payload)]);}
async function clearWizard(id){await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[String(id)]);}
async function audit(id,action,type,entityId,details={}){await pool.execute('INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(id),action,type,entityId,JSON.stringify(details)]);}
function slugify(title){const suffix=randomBytes(3).toString('hex');const base=title.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g,'-').replace(/^-|-$/g,'').slice(0,55)||'campaign';return `${base}-${suffix}`;}
export function registerAdminHandlers(bot){
  bot.command('admin',async ctx=>{if(!isAdmin(ctx))return ctx.reply('دسترسی غیرمجاز.');return ctx.reply('پنل مدیریت ربات',menu());});
  bot.action('admin:roles',async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);await ctx.answerCbQuery();const [rows]=await pool.execute('SELECT telegram_user_id,role,is_active,display_name FROM admin_users ORDER BY role,telegram_user_id');const buttons=rows.map(r=>[Markup.button.callback((Number(r.is_active)?'🟢 ':'🔴 ')+r.telegram_user_id+' | '+r.role,'admin:roles:member:'+r.telegram_user_id)]);buttons.unshift([Markup.button.callback('➕ افزودن مدیر','admin:roles:add')]);buttons.push([Markup.button.callback('بازگشت','admin:home')]);return ctx.reply('🛡 مدیریت دسترسی مدیران\nمدیران ثبت‌شده: '+rows.length+'\nمدیران تعریف‌شده در BOT_ADMIN_IDS همیشه مدیر کل هستند.',Markup.inlineKeyboard(buttons));});
  bot.action('admin:roles:add',async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);await ctx.answerCbQuery();return ctx.reply('نقش مدیر جدید را انتخاب کنید:',Markup.inlineKeyboard([[Markup.button.callback('مدیر کمپین','admin:roles:select:campaign_manager')],[Markup.button.callback('مدیر مالی','admin:roles:select:finance_manager')],[Markup.button.callback('اپراتور پشتیبانی','admin:roles:select:support_agent')]]));});
  bot.action(/^admin:roles:select:(campaign_manager|finance_manager|support_agent)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);await pool.execute('INSERT INTO admin_role_sessions(telegram_user_id,role) VALUES(?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)',[String(ctx.from.id),ctx.match[1]]);await ctx.answerCbQuery();return ctx.reply('شناسه عددی تلگرام مدیر جدید را ارسال کنید.');});
  bot.action(/^admin:roles:member:(\d+)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);const id=ctx.match[1];const [[r]]=await pool.execute('SELECT telegram_user_id,role,is_active,display_name FROM admin_users WHERE telegram_user_id=?',[id]);if(!r)return ctx.answerCbQuery('مدیر پیدا نشد.',{show_alert:true});await ctx.answerCbQuery();return ctx.reply('مدیر: '+id+'\nنقش: '+r.role+'\nوضعیت: '+(Number(r.is_active)?'فعال':'غیرفعال'),Markup.inlineKeyboard([[Markup.button.callback('تغییر به مدیر کمپین','admin:roles:change:'+id+':campaign_manager')],[Markup.button.callback('تغییر به مدیر مالی','admin:roles:change:'+id+':finance_manager')],[Markup.button.callback('تغییر به پشتیبانی','admin:roles:change:'+id+':support_agent')],[Markup.button.callback(Number(r.is_active)?'غیرفعال‌سازی':'فعال‌سازی','admin:roles:toggle:'+id)],[Markup.button.callback('بازگشت','admin:roles')]]));});
  bot.action(/^admin:roles:change:(\d+):(campaign_manager|finance_manager|support_agent)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);const id=ctx.match[1],role=ctx.match[2];const c=await pool.getConnection();try{await c.beginTransaction();const [[r]]=await c.execute('SELECT role FROM admin_users WHERE telegram_user_id=? FOR UPDATE',[id]);if(!r)throw new Error('مدیر پیدا نشد.');await c.execute('UPDATE admin_users SET role=? WHERE telegram_user_id=?',[role,id]);await c.execute("INSERT INTO admin_role_events(target_telegram_id,actor_telegram_id,action,role_before,role_after) VALUES(?,?, 'role_changed',?,?)",[id,String(ctx.from.id),r.role,role]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}await ctx.answerCbQuery('نقش تغییر کرد.');return ctx.reply('نقش مدیر به‌روزرسانی شد.',Markup.inlineKeyboard([[Markup.button.callback('بازگشت به مدیران','admin:roles')]]));});
  bot.action(/^admin:roles:toggle:(\d+)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);const id=ctx.match[1];const c=await pool.getConnection();try{await c.beginTransaction();const [[r]]=await c.execute('SELECT is_active,role FROM admin_users WHERE telegram_user_id=? FOR UPDATE',[id]);if(!r)throw new Error('مدیر پیدا نشد.');const active=Number(r.is_active)?0:1;await c.execute('UPDATE admin_users SET is_active=? WHERE telegram_user_id=?',[active,id]);await c.execute("INSERT INTO admin_role_events(target_telegram_id,actor_telegram_id,action,role_before,role_after) VALUES(?,?,?, ?,?)",[id,String(ctx.from.id),active?'activated':'deactivated',r.role,r.role]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}await ctx.answerCbQuery('وضعیت تغییر کرد.');return ctx.reply('وضعیت دسترسی مدیر تغییر کرد.',Markup.inlineKeyboard([[Markup.button.callback('بازگشت به مدیران','admin:roles')]]));});
  bot.action('admin:home',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return ctx.reply('پنل مدیریت ربات',menu());});
  bot.action('admin:campaigns',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return ctx.reply('مدیریت کمپین‌ها',campaignMenu());});
  bot.action('admin:campaign:add',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await saveWizard(ctx.from.id,'select_type',{});await ctx.answerCbQuery();return ctx.reply('نوع کمپین را انتخاب کنید و سپس «ادامه» را بزنید:',typeMenu());});
  bot.action(/^admin:campaign:type:(free|paid)$/,async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const current=await getWizard(ctx.from.id);if(!current||current.step!=='select_type')return ctx.answerCbQuery('ابتدا از افزودن کمپین شروع کنید.',{show_alert:true});const type=ctx.match[1];await saveWizard(ctx.from.id,'select_type',{type});await ctx.answerCbQuery(type==='free'?'رایگان انتخاب شد.':'پولی انتخاب شد.');return ctx.editMessageReplyMarkup(typeMenu(type).reply_markup);
  });
  bot.action('admin:campaign:continue',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const current=await getWizard(ctx.from.id);if(!current||current.step!=='select_type'||!['free','paid'].includes(current.payload?.type))return ctx.answerCbQuery('ابتدا رایگان یا پولی را انتخاب کنید.',{show_alert:true});await saveWizard(ctx.from.id,'title',current.payload);await ctx.answerCbQuery('ادامه ساخت کمپین');return ctx.reply(current.payload.type==='free'?'نوع رایگان انتخاب شد. عنوان کمپین را ارسال کنید.':'نوع پولی انتخاب شد. عنوان کمپین را ارسال کنید.');});
  bot.action('admin:campaign:cancel',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await clearWizard(ctx.from.id);await ctx.answerCbQuery('لغو شد.');return ctx.reply('ساخت کمپین لغو شد.',campaignMenu());});
  bot.action('admin:campaign:list',async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();
    const [rows]=await pool.execute('SELECT id,title,status,participation_type,entry_price,prize_title,starts_at,ends_at,draw_at,(SELECT COUNT(*) FROM campaign_codes cc WHERE cc.campaign_id=campaigns.id) code_count,(SELECT COUNT(*) FROM campaign_entries ce WHERE ce.campaign_id=campaigns.id AND ce.status IN (\'eligible\',\'pending_payment\')) participant_count FROM campaigns ORDER BY id DESC LIMIT 20');
    if(!rows.length)return ctx.reply('هنوز کمپینی ایجاد نشده است.',campaignMenu());
    for(const c of rows){const label={draft:'پیش‌نویس',scheduled:'زمان‌بندی‌شده',open:'فعال',paused:'متوقف',closed:'بسته',drawn:'قرعه‌کشی‌شده',archived:'بایگانی'}[c.status]||c.status;const detail='#'+c.id+' — '+c.title+'\nنوع: '+(c.participation_type==='free'?'رایگان':'پولی')+'\nوضعیت: '+label+'\nجایزه: '+(c.prize_title||'ثبت نشده')+'\nکدهای صادرشده: '+Number(c.code_count).toLocaleString('fa-IR')+'\nشرکت‌کنندگان/رزروها: '+Number(c.participant_count).toLocaleString('fa-IR')+'\nشروع: '+(c.starts_at||'تعیین نشده')+'\nپایان: '+(c.ends_at||'تعیین نشده')+'\nقرعه‌کشی: '+(c.draw_at||'تعیین نشده')+(c.participation_type==='paid'?'\nمبلغ: '+Number(c.entry_price).toLocaleString('fa-IR')+' ریال':'');await ctx.reply(detail,Markup.inlineKeyboard([[Markup.button.callback(c.status==='open'?'⏸ توقف کمپین':'▶️ فعال‌سازی کمپین',`admin:campaign:toggle:${c.id}`)],[Markup.button.callback('بازگشت','admin:campaigns')]]));}
  });
  bot.action(/^admin:campaign:toggle:(\d+)$/,async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const id=Number(ctx.match[1]);const [[row]]=await pool.execute('SELECT status FROM campaigns WHERE id=?',[id]);if(!row)return ctx.answerCbQuery('کمپین پیدا نشد.',{show_alert:true});
    const next=row.status==='open'?'paused':'open';if(!['draft','paused','open'].includes(row.status))return ctx.answerCbQuery('تغییر وضعیت این کمپین مجاز نیست.',{show_alert:true});
    await pool.execute('UPDATE campaigns SET status=? WHERE id=?',[next,id]);await audit(ctx.from.id,'campaign.status_changed','campaign',id,{from:row.status,to:next});await ctx.answerCbQuery('وضعیت به‌روزرسانی شد.');return ctx.reply(next==='open'?'کمپین فعال شد.':'کمپین متوقف شد.',campaignMenu());
  });

  bot.action('admin:participants',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showParticipants(ctx,0);});
  bot.action(/^admin:participants:page:(\d+)$/,async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showParticipants(ctx,Number(ctx.match[1]));});
  bot.action(/^admin:participant:view:(\d+)$/,async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery();const id=Number(ctx.match[1]);
    const [[p]] = await pool.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,created_at FROM participants WHERE id=?',[id]);
    if(!p)return ctx.reply('شرکت‌کننده پیدا نشد.');
    const [entries]=await pool.execute("SELECT c.id campaign_id,c.title,e.status entry_status,e.created_at,(SELECT COUNT(*) FROM campaign_codes cc WHERE cc.campaign_entry_id=e.id) code_count,(SELECT GROUP_CONCAT(cc.code ORDER BY cc.id SEPARATOR ', ') FROM campaign_codes cc WHERE cc.campaign_entry_id=e.id) codes FROM campaign_entries e JOIN campaigns c ON c.id=e.campaign_id WHERE e.participant_id=? ORDER BY e.id DESC LIMIT 30",[id]);
    const [orders]=await pool.execute("SELECT o.id,o.amount,o.status,o.payment_reference,c.title campaign_title,o.created_at FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id WHERE e.participant_id=? ORDER BY o.id DESC LIMIT 20",[id]);
    const status=p.status==='active'?'فعال':'مسدود';
    let message='👤 پروفایل شرکت‌کننده\nشناسه: '+p.id+'\nTelegram ID: '+p.telegram_user_id+'\nنام: '+p.full_name+'\nموبایل: '+p.phone+'\nاینستاگرام: @'+p.instagram_handle+'\nنام کاربری تلگرام: '+(p.telegram_username?'@'+p.telegram_username:'ندارد')+'\nوضعیت: '+status+'\nعضویت: '+p.created_at+'\n\n🎁 سوابق کمپین:';
    message+='\n'+(entries.length?entries.map(x=>'#'+x.campaign_id+' '+x.title+' | '+x.entry_status+' | '+x.code_count+' کد'+(x.codes?'\n'+x.codes:'')).join('\n'):'بدون سابقه');
    message+='\n\n🧾 سفارش‌ها:';
    message+='\n'+(orders.length?orders.map(x=>'#'+x.id+' '+x.campaign_title+' | '+Number(x.amount).toLocaleString('fa-IR')+' ریال | '+x.status+' | '+(x.payment_reference||'')).join('\n'):'بدون سفارش');
    const action=p.status==='active'?'block':'unblock';
    return ctx.reply(message,Markup.inlineKeyboard([[Markup.button.callback(p.status==='active'?'🚫 مسدودسازی':'✅ رفع مسدودی',`admin:participant:${action}:${id}`)],[Markup.button.callback('↩️ فهرست شرکت‌کنندگان','admin:participants')]]));
  });
  bot.action(/^admin:participant:(block|unblock):(\d+)$/,async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const id=Number(ctx.match[2]),action=ctx.match[1],status=action==='block'?'blocked':'active';
    const c=await pool.getConnection();try{await c.beginTransaction();const [[p]]=await c.execute('SELECT id,status FROM participants WHERE id=? FOR UPDATE',[id]);if(!p){await c.rollback();return ctx.answerCbQuery('شرکت‌کننده پیدا نشد.',{show_alert:true});}if(p.status!==status){await c.execute('UPDATE participants SET status=? WHERE id=?',[status,id]);await c.execute('INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(ctx.from.id),'participant.'+action,'participant',id,JSON.stringify({from:p.status,to:status})]);}await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}
    await ctx.answerCbQuery(action==='block'?'کاربر مسدود شد.':'مسدودی برداشته شد.');return ctx.reply(action==='block'?'حساب شرکت‌کننده مسدود شد.':'حساب شرکت‌کننده دوباره فعال شد.');
  });
  bot.action('admin:participants:export',async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery('در حال آماده‌سازی خروجی...');
    const [rows]=await pool.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,created_at FROM participants ORDER BY id DESC LIMIT 10000');
    const columns=['id','telegram_user_id','telegram_username','full_name','phone','instagram_handle','status','created_at'];
    const csv=toCsv(rows,columns);
    return ctx.replyWithDocument({source:Buffer.from(csv,'utf8'),filename:'participants-export.csv'},{caption:`خروجی شرکت‌کنندگان: ${rows.length} رکورد (حداکثر ۱۰٬۰۰۰ رکورد)`});
  });
  bot.action('admin:support',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showSupportQueue(ctx);});
  bot.action(/^admin:support:page:(\d+)$/,async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showSupportQueue(ctx,Number(ctx.match[1]));});
  bot.action(/^admin:support:view:(\d+)$/,async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();const id=Number(ctx.match[1]);const [[t]]=await pool.execute('SELECT t.*,p.full_name,p.phone,p.telegram_user_id,p.instagram_handle FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=?',[id]);if(!t)return ctx.reply('تیکت پیدا نشد.');const [messages]=await pool.execute('SELECT sender_type,body,created_at FROM support_messages WHERE ticket_id=? ORDER BY id DESC LIMIT 12',[id]);const transcript=messages.reverse().map(m=>(m.sender_type==='admin'?'اپراتور':m.sender_type==='system'?'سیستم':'مشتری')+': '+m.body).join('\n\n').slice(0,3000);const label={new:'جدید',in_progress:'در حال بررسی',answered:'پاسخ داده‌شده',closed:'بسته'}[t.status]||t.status;const priority={low:'کم',normal:'عادی',high:'زیاد',urgent:'فوری'}[t.priority]||t.priority;return ctx.reply('🎫 تیکت '+t.ticket_number+'\nمشتری: '+t.full_name+'\nموبایل: '+t.phone+'\nتلگرام: '+t.telegram_user_id+'\nاینستاگرام: @'+t.instagram_handle+'\nموضوع: '+t.category+'\nعنوان: '+t.subject+'\nوضعیت: '+label+'\nاولویت: '+priority+'\nمسئول: '+(t.assigned_admin_id||'تخصیص‌نیافته')+'\n\n'+(transcript||'بدون پیام'),Markup.inlineKeyboard([[Markup.button.callback('✍️ پاسخ به مشتری','admin:support:reply:'+id)],[Markup.button.callback('👤 تخصیص به من','admin:support:assign:'+id)],[Markup.button.callback(t.status==='closed'?'بازگشایی':'بستن تیکت','admin:support:status:'+id+':'+(t.status==='closed'?'new':'closed'))],[Markup.button.callback('اولویت: زیاد','admin:support:priority:'+id+':high'),Markup.button.callback('اولویت: فوری','admin:support:priority:'+id+':urgent')],[Markup.button.callback('↩️ صف تیکت‌ها','admin:support')]]));});
  bot.action(/^admin:support:assign:(\d+)$/,async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const id=Number(ctx.match[1]);await pool.execute("UPDATE support_tickets SET assigned_admin_id=?,status=IF(status='new','in_progress',status) WHERE id=?",[String(ctx.from.id),id]);await audit(ctx.from.id,'support.assigned','support_ticket',id,{});await ctx.answerCbQuery('تیکت به شما تخصیص یافت.');return ctx.reply('تیکت به شما تخصیص یافت.',Markup.inlineKeyboard([[Markup.button.callback('مشاهده تیکت','admin:support:view:'+id)]]));});
  bot.action(/^admin:support:status:(\d+):(new|in_progress|answered|closed)$/,async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const id=Number(ctx.match[1]),status=ctx.match[2];const [r]=await pool.execute('UPDATE support_tickets SET status=? WHERE id=?',[status,id]);if(!r.affectedRows)return ctx.answerCbQuery('تیکت پیدا نشد.',{show_alert:true});await audit(ctx.from.id,'support.status_changed','support_ticket',id,{status});await ctx.answerCbQuery('وضعیت تغییر کرد.');return ctx.reply('وضعیت تیکت به‌روزرسانی شد.');});
  bot.action(/^admin:support:priority:(\d+):(low|normal|high|urgent)$/,async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const id=Number(ctx.match[1]),priority=ctx.match[2];await pool.execute('UPDATE support_tickets SET priority=? WHERE id=?',[priority,id]);await audit(ctx.from.id,'support.priority_changed','support_ticket',id,{priority});await ctx.answerCbQuery('اولویت تغییر کرد.');return ctx.reply('اولویت تیکت تغییر کرد.');});
  bot.action(/^admin:support:reply:(\d+)$/,async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const id=Number(ctx.match[1]);const [rows]=await pool.execute("SELECT id FROM support_tickets WHERE id=? AND status<>'closed'",[id]);if(!rows.length)return ctx.answerCbQuery('تیکت بسته است یا وجود ندارد.',{show_alert:true});await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,ticket_id) VALUES(?,'admin_reply',?) ON DUPLICATE KEY UPDATE step='admin_reply',ticket_id=VALUES(ticket_id),category=NULL",[String(ctx.from.id),id]);await ctx.answerCbQuery();return ctx.reply('پاسخ خود را به مشتری در یک پیام ارسال کنید.');});
  bot.action('admin:payments',async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery();
    const rows=await listPendingReceipts();
    if(!rows.length)return ctx.reply('رسید در انتظار بررسی وجود ندارد.',menu());
    for(const r of rows){
      const caption='رسید #'+r.receipt_id+' | سفارش #'+r.order_id+'\nکمپین: '+r.campaign_title+'\nمبلغ: '+Number(r.amount).toLocaleString('fa-IR')+' ریال\nکاربر: '+r.full_name+'\nموبایل: '+r.phone+'\nاینستاگرام: @'+r.instagram_handle+'\nیادداشت: '+(r.note||'—');
      await ctx.telegram.sendPhoto(ctx.chat.id,r.telegram_file_id,{caption,reply_markup:Markup.inlineKeyboard([[Markup.button.callback('تأیید پرداخت','payment:approve:'+r.receipt_id)],[Markup.button.callback('رد رسید','payment:reject:'+r.receipt_id)]]).reply_markup});
    }
  });
  bot.action('admin:payment-settings',async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'payment_settings',JSON_OBJECT()) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)",[String(ctx.from.id)]);
    await ctx.answerCbQuery();
    return ctx.reply('اطلاعات کارت را در ۴ خط ارسال کنید:\nنام بانک\nشماره کارت ۱۶ رقمی\nنام صاحب کارت\nتوضیحات یا -');
  });

  bot.action('admin:stats',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();const [[u]]=await pool.query('SELECT COUNT(*) total FROM participants');const [[c]]=await pool.query('SELECT COUNT(*) total FROM campaigns');const [[e]]=await pool.query('SELECT COUNT(*) total FROM campaign_entries');return ctx.reply(`کاربران: ${u.total}\nکمپین‌ها: ${c.total}\nورودی‌های کمپین: ${e.total}`,menu());});
  bot.on('photo',async(ctx,next)=>{if(!isAdmin(ctx))return next();const wizard=await getWizard(ctx.from.id);if(!wizard||wizard.step!=='poster')return next();const photo=ctx.message.photo.at(-1);wizard.payload.posterFileId=photo.file_id;await saveWizard(ctx.from.id,'prize_title',wizard.payload);return ctx.reply('پوستر دریافت شد. نام جایزه را وارد کنید (برای نداشتن جایزه «-»).');});
  bot.on('text',async(ctx,next)=>{
    if(!isAdmin(ctx))return next();
    if(isConfiguredSuperAdmin(ctx.from.id)){const [pending]=await pool.execute('SELECT role FROM admin_role_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);if(pending[0]){const target=ctx.message.text.trim();if(!/^\d{5,20}$/.test(target))return ctx.reply('شناسه تلگرام باید عددی و معتبر باشد.');if(isConfiguredSuperAdmin(target))return ctx.reply('این شناسه از قبل مدیر کل تنظیم‌شده در محیط است.');const c=await pool.getConnection();try{await c.beginTransaction();const [[old]]=await c.execute('SELECT role FROM admin_users WHERE telegram_user_id=? FOR UPDATE',[target]);await c.execute('INSERT INTO admin_users(telegram_user_id,role,is_active,added_by) VALUES(?,?,1,?) ON DUPLICATE KEY UPDATE role=VALUES(role),is_active=1,added_by=VALUES(added_by)',[target,pending[0].role,String(ctx.from.id)]);await c.execute("INSERT INTO admin_role_events(target_telegram_id,actor_telegram_id,action,role_before,role_after) VALUES(?,?,?, ?,?)",[target,String(ctx.from.id),old?'role_changed':'assigned',old?.role||null,pending[0].role]);await c.execute('DELETE FROM admin_role_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}return ctx.reply('دسترسی مدیر ثبت شد: '+target+' | '+pending[0].role,Markup.inlineKeyboard([[Markup.button.callback('مدیریت مدیران','admin:roles')]]));}}
    const wizard=await getWizard(ctx.from.id);
    const [supportRows]=await pool.execute("SELECT step,ticket_id FROM support_sessions WHERE telegram_user_id=? AND step='admin_reply'",[String(ctx.from.id)]);
    if(supportRows[0]){const body=ctx.message.text.trim();if(!body||body.startsWith('/'))return ctx.reply('متن پاسخ را ارسال کنید.');if(body.length>4000)return ctx.reply('پاسخ حداکثر ۴۰۰۰ نویسه باشد.');const ticketId=supportRows[0].ticket_id;const c=await pool.getConnection();let chatId;try{await c.beginTransaction();const [[t]]=await c.execute("SELECT t.id,t.ticket_number,t.status,p.telegram_user_id FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=? FOR UPDATE",[ticketId]);if(!t||t.status==='closed')throw new Error('تیکت بسته شده یا وجود ندارد.');chatId=String(t.telegram_user_id);await c.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'admin',?,?)",[ticketId,String(ctx.from.id),body]);await c.execute("UPDATE support_tickets SET status='answered',last_message_at=UTC_TIMESTAMP() WHERE id=?",[ticketId]);await c.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}await ctx.telegram.sendMessage(chatId,'پاسخ پشتیبانی برای تیکت شما:\n'+body).catch(()=>{});return ctx.reply('پاسخ ثبت شد و برای مشتری ارسال شد.',Markup.inlineKeyboard([[Markup.button.callback('مشاهده تیکت','admin:support:view:'+ticketId)]]));}
    if(!wizard)return next();
    const value=ctx.message.text.trim();const p=wizard.payload;
    try{
      if(wizard.step==='title'){if(value.length<3||value.length>180)throw new Error('عنوان باید بین ۳ تا ۱۸۰ نویسه باشد.');p.title=value;await saveWizard(ctx.from.id,'description',p);return ctx.reply('توضیح کمپین را بنویسید. برای بدون توضیح، «-» ارسال کنید.');}
      if(wizard.step==='description'){p.description=value==='-'?'':value;if(p.description.length>3000)throw new Error('توضیح حداکثر ۳۰۰۰ نویسه باشد.');await saveWizard(ctx.from.id,'poster',p);return ctx.reply('پوستر کمپین را به‌صورت عکس ارسال کنید؛ برای رد کردن این مرحله /skip را بفرستید.');}
      if(wizard.step==='poster'){if(value!=='/skip')throw new Error('برای پوستر عکس ارسال کنید یا /skip را بزنید.');await saveWizard(ctx.from.id,'prize_title',p);return ctx.reply('نام جایزه را وارد کنید (برای نداشتن جایزه «-»).');}
      if(wizard.step==='prize_title'){p.prizeTitle=value==='-'?'':value;if(p.prizeTitle.length>180)throw new Error('نام جایزه حداکثر ۱۸۰ نویسه باشد.');await saveWizard(ctx.from.id,'prize_description',p);return ctx.reply('توضیحات جایزه را وارد کنید یا «-» بفرستید.');}
      if(wizard.step==='prize_description'){p.prizeDescription=value==='-'?'':value;if(p.prizeDescription.length>2000)throw new Error('توضیحات جایزه حداکثر ۲۰۰۰ نویسه باشد.');await saveWizard(ctx.from.id,'prize_value',p);return ctx.reply('ارزش تقریبی جایزه را به ریال وارد کنید؛ ۰ یعنی ثبت نشده.');}
      if(wizard.step==='prize_value'){if(!/^\d+$/.test(value)||Number(value)>100000000000000)throw new Error('ارزش جایزه باید عدد صحیح نامنفی باشد.');p.prizeValue=Number(value)||null;await saveWizard(ctx.from.id,'starts_at',p);return ctx.reply('زمان شروع را به شکل YYYY-MM-DD HH:mm وارد کنید یا «-» بفرستید.');}
      if(['starts_at','ends_at','draw_at'].includes(wizard.step)){const key=wizard.step;if(value==='-')p[key]=null;else{if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)||Number.isNaN(Date.parse(value.replace(' ','T')+':00Z')))throw new Error('فرمت زمان معتبر نیست؛ نمونه: 2026-12-01 18:30');p[key]=value+':00';}const nextStep={starts_at:'ends_at',ends_at:'draw_at',draw_at:'terms'}[key];await saveWizard(ctx.from.id,nextStep,p);return ctx.reply(nextStep==='terms'?'قوانین و شرایط شرکت را وارد کنید؛ برای بدون قانون «-».':nextStep==='ends_at'?'زمان پایان را وارد کنید یا «-» بفرستید.':'زمان قرعه‌کشی را وارد کنید یا «-» بفرستید.');}
      if(wizard.step==='terms'){p.terms=value==='-'?'':value;if(p.terms.length>8000)throw new Error('قوانین حداکثر ۸۰۰۰ نویسه باشد.');await saveWizard(ctx.from.id,'capacity',p);return ctx.reply('ظرفیت کمپین را به عدد وارد کنید. عدد ۰ یعنی نامحدود.');}
      if(wizard.step==='capacity'){if(!/^\d+$/.test(value)||Number(value)>10000000)throw new Error('ظرفیت باید عدد صحیح باشد؛ ۰ یعنی نامحدود.');p.capacity=Number(value)||null;await saveWizard(ctx.from.id,'codes',p);return ctx.reply('تعداد کد برای هر شرکت‌کننده را وارد کنید (۱ تا ۱۰۰).');}
      if(wizard.step==='codes'){if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>100)throw new Error('تعداد کد باید بین ۱ تا ۱۰۰ باشد.');p.codes=Number(value);if(p.type==='paid'){await saveWizard(ctx.from.id,'price',p);return ctx.reply('مبلغ شرکت در کمپین را به ریال وارد کنید (عدد صحیح مثبت).');}p.paymentMethods=[];return showConfirmation(ctx,p);}
      if(wizard.step==='price'){if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>1000000000000)throw new Error('مبلغ باید عدد صحیح مثبت و به ریال باشد.');p.price=Number(value);p.paymentMethods=['card_transfer','gateway'];return showConfirmation(ctx,p);}
    }catch(error){return ctx.reply(error.message||'ورودی نامعتبر است. دوباره تلاش کنید.');}
    return next();
  });
  bot.action('admin:campaign:confirm',async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const wizard=await getWizard(ctx.from.id);if(!wizard||wizard.step!=='confirm')return ctx.answerCbQuery('فرایند ساخت کمپین منقضی شده است.',{show_alert:true});
    const p=wizard.payload;const slug=slugify(p.title);
    if(p.starts_at&&p.ends_at&&new Date(p.starts_at).getTime()>=new Date(p.ends_at).getTime())return ctx.answerCbQuery('زمان پایان باید بعد از شروع باشد.',{show_alert:true});if(p.draw_at&&p.ends_at&&new Date(p.draw_at).getTime()<new Date(p.ends_at).getTime())return ctx.answerCbQuery('زمان قرعه‌کشی نباید قبل از پایان کمپین باشد.',{show_alert:true});const [result]=await pool.execute("INSERT INTO campaigns(slug,title,description,poster_file_id,prize_title,prize_description,prize_value,status,participation_type,entry_price,payment_methods,starts_at,ends_at,draw_at,terms,capacity,codes_per_entry) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)",[slug,p.title,p.description,p.posterFileId||null,p.prizeTitle||null,p.prizeDescription||null,p.prizeValue||null,p.type,p.type==='paid'?p.price:0,JSON.stringify(p.paymentMethods||[]),p.starts_at,p.ends_at,p.draw_at,p.terms||null,p.capacity,p.codes]);
    await audit(ctx.from.id,'campaign.created','campaign',result.insertId,{type:p.type,title:p.title});
    await clearWizard(ctx.from.id);await ctx.answerCbQuery('کمپین ایجاد شد.');
    return ctx.reply(`کمپین «${p.title}» به‌صورت پیش‌نویس ایجاد شد. برای نمایش به کاربران، آن را از فهرست کمپین‌ها فعال کنید.`,campaignMenu());
  });
  bot.action('admin:campaign:restart',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await saveWizard(ctx.from.id,'select_type',{});await ctx.answerCbQuery();return ctx.reply('نوع کمپین را انتخاب کنید و سپس «ادامه» را بزنید:',typeMenu());});
}
async function showConfirmation(ctx,p){
  await saveWizard(ctx.from.id,'confirm',p);
  const type=p.type==='free'?'رایگان':'پولی';const price=p.type==='paid'?`\nمبلغ: ${Number(p.price).toLocaleString('fa-IR')} ریال`:'';
  const summary=`پیش‌نمایش کمپین\nعنوان: ${p.title}\nنوع: ${type}${price}\nجایزه: ${p.prizeTitle||'ثبت نشده'}\nارزش جایزه: ${p.prizeValue?Number(p.prizeValue).toLocaleString('fa-IR')+' ریال':'ثبت نشده'}\nشروع: ${p.starts_at||'تعیین نشده'}\nپایان: ${p.ends_at||'تعیین نشده'}\nقرعه‌کشی: ${p.draw_at||'تعیین نشده'}\nظرفیت: ${p.capacity??'نامحدود'}\nکد برای هر نفر: ${p.codes}\nپوستر: ${p.posterFileId?'دریافت شد':'ندارد'}\nتوضیح: ${p.description||'ندارد'}\nقوانین: ${p.terms||'ثبت نشده'}\n\nبا تأیید، کمپین به‌صورت پیش‌نویس ذخیره می‌شود.`;
  return ctx.reply(summary,Markup.inlineKeyboard([[Markup.button.callback('تأیید و ایجاد کمپین','admin:campaign:confirm')],[Markup.button.callback('لغو','admin:campaign:cancel')]]));
}
