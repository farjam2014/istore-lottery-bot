import {randomBytes} from 'node:crypto';
import {config} from '../../config/env.js';
import {pool} from '../../database/pool.js';
import {Markup} from 'telegraf';
import {listPendingReceipts} from '../../modules/payments/payment.service.js';
import {toCsv} from '../../shared/csv.js';
import {hasPermission,isConfiguredSuperAdmin,getAdminRole} from '../../modules/admin/admin-role.service.js';
import {changeAdminRole,toggleAdminActive} from '../../modules/admin/admin-access.service.js';
import {getManagementReport,reportRows} from '../../modules/reports/management-report.service.js';
import {normalizeFullName,normalizePhone,normalizeInstagram} from '../../modules/participants/participant.service.js';
import {listManagedOrders,searchManagedOrders,getManagedOrderDetail,exportManagedOrders} from '../../modules/payments/payment-admin.service.js';
import {enqueueTelegramNotification} from '../../modules/notifications/outbox.service.js';
import {getCorrelationId} from '../../shared/request-context.js';

async function isAdmin(ctx){
  const id=ctx.from?.id;if(!id)return false;
  if(isConfiguredSuperAdmin(id))return true;
  if(ctx.callbackQuery){
    const data=ctx.callbackQuery.data||'';
    if(data.startsWith('admin:roles'))return false;
    if(data.startsWith('admin:campaign'))return hasPermission(id,'campaign.write');
    if(data.startsWith('admin:participants:export')||data==='admin:participants:search')return hasPermission(id,'participant.read');
    if(data.startsWith('admin:participant:'))return hasPermission(id,data.includes(':block:')||data.includes(':unblock:')?'participant.manage':'participant.read');
    if(data.startsWith('admin:participants'))return hasPermission(id,'participant.read');
    if(data.startsWith('admin:support:reply'))return hasPermission(id,'support.reply');
    if(data.startsWith('admin:support:assign')||data.startsWith('admin:support:status')||data.startsWith('admin:support:priority'))return hasPermission(id,'support.manage');
    if(data.startsWith('admin:support'))return hasPermission(id,'support.read');
    if(data.startsWith('admin:payments')||data.startsWith('admin:payment:order:')||data==='admin:payment:export'||data==='admin:payment:search')return hasPermission(id,'payment.read');
    if(data==='admin:payment-settings')return hasPermission(id,'payment.settings');
    if(data==='admin:stats'||data.startsWith('admin:reports')||data.startsWith('admin:report:'))return hasPermission(id,'report.read');
    if(data==='admin:home'||data==='admin:campaigns')return hasPermission(id,'dashboard.read')||hasPermission(id,'campaign.read');
    return false;
  }
  if(ctx.message?.text?.startsWith('/admin'))return hasPermission(id,'dashboard.read');
  if(ctx.message?.text){
    const [[paySession]]=await pool.execute('SELECT step FROM payment_admin_sessions WHERE telegram_user_id=?',[String(id)]);if(paySession?.step==='search_order')return hasPermission(id,'payment.read');
    const [[searchSession]]=await pool.execute("SELECT step FROM admin_search_sessions WHERE telegram_user_id=?",[String(id)]);if(searchSession?.step==='participant')return hasPermission(id,'participant.read');
    const [[session]]=await pool.execute('SELECT step FROM support_sessions WHERE telegram_user_id=?',[String(id)]);
    if(session?.step==='admin_reply')return hasPermission(id,'support.reply');
    const [[wizard]]=await pool.execute('SELECT step FROM admin_wizards WHERE telegram_user_id=?',[String(id)]);
    if(wizard?.step==='payment_settings')return hasPermission(id,'payment.settings');
    if(wizard?.step==='payment_reject')return hasPermission(id,'payment.review');
    return hasPermission(id,'campaign.write');
  }
  if(ctx.message?.photo)return hasPermission(id,'campaign.write');
  return false;
}
const can=async(ctx,permission)=>hasPermission(ctx.from?.id,permission);
const deny=ctx=>ctx.answerCbQuery('برای این عملیات مجوز ندارید.',{show_alert:true});
const menu=role=>{const rows=[];const allow=p=>role==='super_admin'||(rolePermissionsForMenu[role]||[]).includes(p);
  if(allow('campaign.write'))rows.push([Markup.button.callback('🎯 مدیریت کمپین‌ها','admin:campaigns')]);
  if(allow('participant.read'))rows.push([Markup.button.callback('👥 مدیریت شرکت‌کنندگان','admin:participants')]);
  if(allow('support.read'))rows.push([Markup.button.callback('💬 تیکت‌های پشتیبانی','admin:support')]);
  if(role==='super_admin')rows.push([Markup.button.callback('🛡 مدیریت مدیران و نقش‌ها','admin:roles')]);
  if(allow('report.read'))rows.push([Markup.button.callback('📊 گزارش‌ها و عملکرد مالی','admin:reports')]);
  if(allow('payment.read'))rows.push([Markup.button.callback('🧾 مرکز سفارش‌ها و پرداخت‌ها','admin:payments')]);
  if(allow('payment.settings'))rows.push([Markup.button.callback('💳 تنظیم کارت بانکی','admin:payment-settings')]);
  if(role==='super_admin')rows.push([Markup.button.callback('📝 درخواست‌های اصلاح پروفایل','admin:profile-requests')]);
  if(role==='super_admin')rows.push([Markup.button.callback('🩺 سلامت و نظارت سامانه','admin:system')]);
  return Markup.inlineKeyboard(rows);
};
const rolePermissionsForMenu={
  campaign_manager:['campaign.write','participant.read'],
  finance_manager:['payment.read','payment.settings','report.read','participant.read'],
  support_agent:['support.read','participant.read']
};

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
async function audit(id,action,type,entityId,details={}){await pool.execute('INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',[String(id),getCorrelationId(),action,type,entityId,JSON.stringify(details)]);}
function slugify(title){const suffix=randomBytes(3).toString('hex');const base=title.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g,'-').replace(/^-|-$/g,'').slice(0,55)||'campaign';return `${base}-${suffix}`;}
export function registerAdminHandlers(bot){
  bot.command('admin',async ctx=>{if(!await isAdmin(ctx))return ctx.reply('دسترسی غیرمجاز.');const admin=await getAdminRole(ctx.from.id);return ctx.reply('پنل مدیریت ربات',menu(admin?.role));});
  bot.action('admin:roles',async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);await ctx.answerCbQuery();const [rows]=await pool.execute('SELECT telegram_user_id,role,is_active,display_name FROM admin_users ORDER BY role,telegram_user_id');const buttons=rows.map(r=>[Markup.button.callback((Number(r.is_active)?'🟢 ':'🔴 ')+r.telegram_user_id+' | '+r.role,'admin:roles:member:'+r.telegram_user_id)]);buttons.unshift([Markup.button.callback('➕ افزودن مدیر','admin:roles:add')]);buttons.push([Markup.button.callback('بازگشت','admin:home')]);return ctx.reply('🛡 مدیریت دسترسی مدیران\nمدیران ثبت‌شده: '+rows.length+'\nمدیران تعریف‌شده در BOT_ADMIN_IDS همیشه مدیر کل هستند.',Markup.inlineKeyboard(buttons));});
  bot.action('admin:roles:add',async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);await ctx.answerCbQuery();return ctx.reply('نقش مدیر جدید را انتخاب کنید:',Markup.inlineKeyboard([[Markup.button.callback('مدیر کمپین','admin:roles:select:campaign_manager')],[Markup.button.callback('مدیر مالی','admin:roles:select:finance_manager')],[Markup.button.callback('اپراتور پشتیبانی','admin:roles:select:support_agent')]]));});
  bot.action(/^admin:roles:select:(campaign_manager|finance_manager|support_agent)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);await pool.execute('INSERT INTO admin_role_sessions(telegram_user_id,role) VALUES(?,?) ON DUPLICATE KEY UPDATE role=VALUES(role)',[String(ctx.from.id),ctx.match[1]]);await ctx.answerCbQuery();return ctx.reply('شناسه عددی تلگرام مدیر جدید را ارسال کنید.');});
  bot.action(/^admin:roles:member:(\d+)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);const id=ctx.match[1];const [[r]]=await pool.execute('SELECT telegram_user_id,role,is_active,display_name FROM admin_users WHERE telegram_user_id=?',[id]);if(!r)return ctx.answerCbQuery('مدیر پیدا نشد.',{show_alert:true});await ctx.answerCbQuery();return ctx.reply('مدیر: '+id+'\nنقش: '+r.role+'\nوضعیت: '+(Number(r.is_active)?'فعال':'غیرفعال'),Markup.inlineKeyboard([[Markup.button.callback('تغییر به مدیر کمپین','admin:roles:change:'+id+':campaign_manager')],[Markup.button.callback('تغییر به مدیر مالی','admin:roles:change:'+id+':finance_manager')],[Markup.button.callback('تغییر به پشتیبانی','admin:roles:change:'+id+':support_agent')],[Markup.button.callback(Number(r.is_active)?'غیرفعال‌سازی':'فعال‌سازی','admin:roles:toggle:'+id)],[Markup.button.callback('بازگشت','admin:roles')]]));});
  bot.action(/^admin:roles:change:(\d+):(campaign_manager|finance_manager|support_agent)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);try{await changeAdminRole({targetId:ctx.match[1],actorId:ctx.from.id,role:ctx.match[2]});}catch(e){return ctx.answerCbQuery(e.message||'تغییر نقش ناموفق بود.',{show_alert:true});}await ctx.answerCbQuery('نقش تغییر کرد.');return ctx.reply('نقش مدیر به‌روزرسانی شد.',Markup.inlineKeyboard([[Markup.button.callback('بازگشت به مدیران','admin:roles')]]));});
  bot.action(/^admin:roles:toggle:(\d+)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);try{await toggleAdminActive({targetId:ctx.match[1],actorId:ctx.from.id});}catch(e){return ctx.answerCbQuery(e.message||'تغییر وضعیت ناموفق بود.',{show_alert:true});}await ctx.answerCbQuery('وضعیت تغییر کرد.');return ctx.reply('وضعیت دسترسی مدیر تغییر کرد.',Markup.inlineKeyboard([[Markup.button.callback('بازگشت به مدیران','admin:roles')]]));});
  bot.action('admin:system',async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);await ctx.answerCbQuery();const [[outbox]]=await pool.execute("SELECT SUM(status='pending') pending,SUM(status='sending') sending,SUM(status='sent') sent,SUM(status='failed') failed,SUM(status='uncertain') uncertain FROM telegram_notification_outbox");const [[updates]]=await pool.execute("SELECT COUNT(*) total FROM processed_updates WHERE processed_at>=UTC_TIMESTAMP()-INTERVAL 24 HOUR");const [[limits]]=await pool.execute("SELECT COUNT(*) total FROM telegram_rate_limits WHERE window_started_at>=UTC_TIMESTAMP()-INTERVAL 1 HOUR AND request_count>10");const [failed]=await pool.execute("SELECT id,chat_id,attempts,last_error,created_at FROM telegram_notification_outbox WHERE status='failed' ORDER BY id DESC LIMIT 8");const msg='🩺 سلامت سامانه\n\n📨 صف اعلان‌ها\nدر انتظار: '+Number(outbox.pending||0)+'\nدر حال ارسال: '+Number(outbox.sending||0)+'\nارسال‌شده: '+Number(outbox.sent||0)+'\nناموفق نهایی: '+Number(outbox.failed||0)+'\nنتیجه نامشخص (نیازمند بررسی): '+Number(outbox.uncertain||0)+'\n\n🔐 پردازش و محدودسازی\nUpdateهای ۲۴ ساعت: '+Number(updates.total||0)+'\nکاربران با محدودیت فعال در ساعت اخیر: '+Number(limits.total||0)+'\n\nخطاهای اخیر:\n'+(failed.length?failed.map(x=>'#'+x.id+' | تلاش: '+x.attempts+' | '+String(x.last_error||'بدون جزئیات').slice(0,120)).join('\n'):'خطای نهایی ثبت نشده است.');return ctx.reply(msg,Markup.inlineKeyboard([[Markup.button.callback('♻️ تلاش مجدد اعلان‌های ناموفق','admin:system:outbox:retry')],[Markup.button.callback('⚠️ ارسال مجدد موارد نامشخص','admin:system:outbox:retry-uncertain')],[Markup.button.callback('بازخوانی وضعیت','admin:system')],[Markup.button.callback('بازگشت','admin:home')]]));});
  bot.action('admin:system:outbox:retry',async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);const [r]=await pool.execute("UPDATE telegram_notification_outbox SET status='pending',attempts=0,manual_retry_count=manual_retry_count+1,available_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error=NULL WHERE status='failed'");await audit(ctx.from.id,'system.outbox_retry_failed','notification_outbox',null,{count:r.affectedRows});await ctx.answerCbQuery('اعلان‌های ناموفق به صف بازگشتند.');return ctx.reply('تعداد اعلان‌های ناموفق بازگردانده‌شده: '+r.affectedRows,Markup.inlineKeyboard([[Markup.button.callback('بازخوانی سلامت سامانه','admin:system')]]));});
  bot.action('admin:system:outbox:retry-uncertain',async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);const [r]=await pool.execute("UPDATE telegram_notification_outbox SET status='pending',attempts=0,manual_retry_count=manual_retry_count+1,available_at=UTC_TIMESTAMP(),locked_at=NULL,lease_token=NULL,last_error=CONCAT(COALESCE(last_error,''),' | manual retry by ',?) WHERE status='uncertain'",[String(ctx.from.id)]);await audit(ctx.from.id,'system.outbox_retry_uncertain','notification_outbox',null,{count:r.affectedRows,warning:'Telegram may already have delivered these messages; retry can create duplicates.'});await ctx.answerCbQuery('موارد نامشخص به‌صورت دستی به صف بازگشتند.');return ctx.reply('تعداد اعلان‌های با نتیجه نامشخص که دوباره صف شدند: '+r.affectedRows+'\\nهشدار: ممکن است بعضی از این پیام‌ها قبلاً به مقصد رسیده باشند و ارسال مجدد باعث تکرار شود.',Markup.inlineKeyboard([[Markup.button.callback('بازخوانی سلامت سامانه','admin:system')]]));});
    bot.action('admin:profile-requests',async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);await ctx.answerCbQuery();const [rows]=await pool.execute("SELECT r.id,r.created_at,p.full_name,p.phone FROM profile_change_requests r JOIN participants p ON p.id=r.participant_id WHERE r.status='pending' ORDER BY r.created_at ASC LIMIT 30");if(!rows.length)return ctx.reply('درخواست اصلاح پروفایل در انتظار بررسی وجود ندارد.',Markup.inlineKeyboard([[Markup.button.callback('بازگشت','admin:home')]]));const buttons=rows.map(r=>[Markup.button.callback('#'+r.id+' | '+r.full_name+' | '+r.phone,'admin:profile-request:view:'+r.id)]);buttons.push([Markup.button.callback('بازگشت','admin:home')]);return ctx.reply('درخواست‌های اصلاح پروفایل: '+rows.length,Markup.inlineKeyboard(buttons));});
  bot.action(/^admin:profile-request:view:(\d+)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);const id=Number(ctx.match[1]);const [[r]]=await pool.execute("SELECT r.id,r.participant_id,r.requested_profile,r.reason,r.status,p.telegram_user_id,p.full_name,p.phone,p.instagram_handle FROM profile_change_requests r JOIN participants p ON p.id=r.participant_id WHERE r.id=?",[id]);if(!r)return ctx.answerCbQuery('درخواست پیدا نشد.',{show_alert:true});const request=typeof r.requested_profile==='string'?JSON.parse(r.requested_profile):r.requested_profile;await ctx.answerCbQuery();return ctx.reply('درخواست اصلاح پروفایل #'+id+'\nمشتری: '+r.full_name+'\nموبایل فعلی: '+r.phone+'\nاینستاگرام فعلی: @'+r.instagram_handle+'\nفیلد درخواستی: '+request.field+'\nمقدار جدید: '+request.value+'\nوضعیت: '+r.status,Markup.inlineKeyboard([[Markup.button.callback('تأیید درخواست','admin:profile-request:approve:'+id)],[Markup.button.callback('رد درخواست','admin:profile-request:reject:'+id)],[Markup.button.callback('بازگشت','admin:profile-requests')]]));});
  bot.action(/^admin:profile-request:(approve|reject):(\d+)$/,async ctx=>{if(!isConfiguredSuperAdmin(ctx.from.id))return deny(ctx);const decision=ctx.match[1],id=Number(ctx.match[2]);const c=await pool.getConnection();let userId;try{await c.beginTransaction();const [[r]]=await c.execute("SELECT r.id,r.participant_id,r.requested_profile,r.status,p.telegram_user_id FROM profile_change_requests r JOIN participants p ON p.id=r.participant_id WHERE r.id=? FOR UPDATE",[id]);if(!r||r.status!=='pending')throw new Error('درخواست وجود ندارد یا قبلاً بررسی شده است.');userId=String(r.telegram_user_id);if(decision==='approve'){const request=typeof r.requested_profile==='string'?JSON.parse(r.requested_profile):r.requested_profile;const validators={full_name:normalizeFullName,phone:normalizePhone,instagram_handle:normalizeInstagram};const column=request.field;if(!Object.hasOwn(validators,column)||typeof request.value!=='string')throw new Error('اطلاعات درخواست معتبر نیست.');const value=validators[column](request.value);await c.execute('UPDATE participants SET '+column+'=? WHERE id=?',[value,r.participant_id]);}await c.execute("UPDATE profile_change_requests SET status=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?",[decision==='approve'?'approved':'rejected',String(ctx.from.id),id]);await c.execute("INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",[String(ctx.from.id),'profile_change.'+decision,'profile_change_request',id,JSON.stringify({participant_id:r.participant_id})]);await enqueueTelegramNotification({chatId:userId,text:decision==='approve'?'درخواست اصلاح اطلاعات شما تأیید شد. اطلاعات حساب به‌روزرسانی شد.':'درخواست اصلاح اطلاعات شما رد شد. برای پیگیری با پشتیبانی تماس بگیرید.',executor:c});await c.commit();}catch(e){await c.rollback();return ctx.answerCbQuery(e.message||'بررسی درخواست ناموفق بود.',{show_alert:true});}finally{c.release();}await ctx.answerCbQuery(decision==='approve'?'تأیید شد.':'رد شد.');return ctx.reply('نتیجه درخواست ثبت شد.',Markup.inlineKeyboard([[Markup.button.callback('بازگشت به درخواست‌ها','admin:profile-requests')]]));});
  bot.action('admin:home',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();const admin=await getAdminRole(ctx.from.id);return ctx.reply('پنل مدیریت ربات',menu(admin?.role));});
  bot.action('admin:campaigns',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return ctx.reply('مدیریت کمپین‌ها',campaignMenu());});
  bot.action('admin:campaign:add',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await saveWizard(ctx.from.id,'select_type',{});await ctx.answerCbQuery();return ctx.reply('نوع کمپین را انتخاب کنید و سپس «ادامه» را بزنید:',typeMenu());});
  bot.action(/^admin:campaign:type:(free|paid)$/,async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const current=await getWizard(ctx.from.id);if(!current||current.step!=='select_type')return ctx.answerCbQuery('ابتدا از افزودن کمپین شروع کنید.',{show_alert:true});const type=ctx.match[1];await saveWizard(ctx.from.id,'select_type',{type});await ctx.answerCbQuery(type==='free'?'رایگان انتخاب شد.':'پولی انتخاب شد.');return ctx.editMessageReplyMarkup(typeMenu(type).reply_markup);
  });
  bot.action('admin:campaign:continue',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const current=await getWizard(ctx.from.id);if(!current||current.step!=='select_type'||!['free','paid'].includes(current.payload?.type))return ctx.answerCbQuery('ابتدا رایگان یا پولی را انتخاب کنید.',{show_alert:true});await saveWizard(ctx.from.id,'title',current.payload);await ctx.answerCbQuery('ادامه ساخت کمپین');return ctx.reply(current.payload.type==='free'?'نوع رایگان انتخاب شد. عنوان کمپین را ارسال کنید.':'نوع پولی انتخاب شد. عنوان کمپین را ارسال کنید.');});
  bot.action('admin:campaign:cancel',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await clearWizard(ctx.from.id);await ctx.answerCbQuery('لغو شد.');return ctx.reply('ساخت کمپین لغو شد.',campaignMenu());});
  bot.action('admin:campaign:list',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();
    const [rows]=await pool.execute('SELECT id,title,status,participation_type,entry_price,prize_title,starts_at,ends_at,draw_at,(SELECT COUNT(*) FROM campaign_codes cc WHERE cc.campaign_id=campaigns.id) code_count,(SELECT COUNT(*) FROM campaign_entries ce WHERE ce.campaign_id=campaigns.id AND ce.status IN (\'eligible\',\'pending_payment\')) participant_count FROM campaigns ORDER BY id DESC LIMIT 20');
    if(!rows.length)return ctx.reply('هنوز کمپینی ایجاد نشده است.',campaignMenu());
    for(const c of rows){const label={draft:'پیش‌نویس',scheduled:'زمان‌بندی‌شده',open:'فعال',paused:'متوقف',closed:'بسته',drawn:'قرعه‌کشی‌شده',archived:'بایگانی'}[c.status]||c.status;const detail='#'+c.id+' — '+c.title+'\nنوع: '+(c.participation_type==='free'?'رایگان':'پولی')+'\nوضعیت: '+label+'\nجایزه: '+(c.prize_title||'ثبت نشده')+'\nکدهای صادرشده: '+Number(c.code_count).toLocaleString('fa-IR')+'\nشرکت‌کنندگان/رزروها: '+Number(c.participant_count).toLocaleString('fa-IR')+'\nشروع: '+(c.starts_at||'تعیین نشده')+'\nپایان: '+(c.ends_at||'تعیین نشده')+'\nقرعه‌کشی: '+(c.draw_at||'تعیین نشده')+(c.participation_type==='paid'?'\nمبلغ: '+Number(c.entry_price).toLocaleString('fa-IR')+' ریال':'');const actions=[];if(['draft','scheduled','paused','open'].includes(c.status))actions.push([Markup.button.callback(c.status==='open'?'⏸ توقف کمپین':'▶️ فعال‌سازی کمپین',`admin:campaign:toggle:${c.id}`)]);if(c.status==='draft')actions.push([Markup.button.callback('✏️ ویرایش مشخصات','admin:campaign:edit-menu:'+c.id)]);actions.push([Markup.button.callback('📄 کپی به‌عنوان پیش‌نویس',`admin:campaign:copy:${c.id}`)]);if(['draft','paused','closed'].includes(c.status))actions.push([Markup.button.callback('🗄 بایگانی کمپین',`admin:campaign:archive:${c.id}`)]);actions.push([Markup.button.callback('بازگشت','admin:campaigns')]);await ctx.reply(detail,Markup.inlineKeyboard(actions));}
  });
  bot.action(/^admin:campaign:edit-menu:(\d+)$/,async ctx=>{
    if(!await hasPermission(ctx.from.id,'campaign.write'))return deny(ctx);
    const id=Number(ctx.match[1]);const [[row]]=await pool.execute("SELECT id,status FROM campaigns WHERE id=?",[id]);
    if(!row||row.status!=='draft')return ctx.answerCbQuery('فقط کمپین پیش‌نویس قابل ویرایش است.',{show_alert:true});
    await ctx.answerCbQuery();
    return ctx.reply('فیلدی را برای ویرایش انتخاب کنید:',Markup.inlineKeyboard([
      [Markup.button.callback('عنوان','admin:campaign:edit:'+id+':title'),Markup.button.callback('توضیحات','admin:campaign:edit:'+id+':description')],
      [Markup.button.callback('نام جایزه','admin:campaign:edit:'+id+':prize_title'),Markup.button.callback('توضیح جایزه','admin:campaign:edit:'+id+':prize_description')],
      [Markup.button.callback('قوانین','admin:campaign:edit:'+id+':terms')],
      [Markup.button.callback('شروع','admin:campaign:edit:'+id+':starts_at'),Markup.button.callback('پایان','admin:campaign:edit:'+id+':ends_at'),Markup.button.callback('زمان قرعه‌کشی','admin:campaign:edit:'+id+':draw_at')],
      [Markup.button.callback('مبلغ شرکت','admin:campaign:edit:'+id+':entry_price'),Markup.button.callback('ظرفیت','admin:campaign:edit:'+id+':capacity')],
      [Markup.button.callback('تعداد کد هر نفر','admin:campaign:edit:'+id+':codes_per_entry)],
      [Markup.button.callback('بازگشت','admin:campaign:list')]
    ]));
  });
  bot.action(/^admin:campaign:edit:(\d+):(title|description|prize_title|prize_description|terms|entry_price|capacity|codes_per_entry|starts_at|ends_at|draw_at)$/,async ctx=>{
    if(!await hasPermission(ctx.from.id,'campaign.write'))return deny(ctx);
    const id=Number(ctx.match[1]),field=ctx.match[2];const [[row]]=await pool.execute("SELECT status,participation_type FROM campaigns WHERE id=?",[id]);
    if(!row||row.status!=='draft')return ctx.answerCbQuery('فقط کمپین پیش‌نویس قابل ویرایش است.',{show_alert:true});
    if(field==='entry_price'&&row.participation_type!=='paid')return ctx.answerCbQuery('کمپین رایگان مبلغ شرکت ندارد.',{show_alert:true});
    await saveWizard(ctx.from.id,'campaign_edit_value',{campaignId:id,field});await ctx.answerCbQuery();
    return ctx.reply('مقدار جدید را ارسال کنید. برای پاک‌کردن فیلدهای متنی «-» بفرستید.');
  });
  bot.action(/^admin:campaign:copy:(\d+)$/,async ctx=>{
    if(!await hasPermission(ctx.from.id,'campaign.write'))return deny(ctx);
    const id=Number(ctx.match[1]);const [[source]]=await pool.execute('SELECT * FROM campaigns WHERE id=?',[id]);
    if(!source)return ctx.answerCbQuery('کمپین پیدا نشد.',{show_alert:true});
    const slug=slugify(source.title+'-copy');
    const [created]=await pool.execute("INSERT INTO campaigns(slug,title,description,poster_file_id,prize_title,prize_description,prize_value,status,participation_type,entry_price,payment_methods,starts_at,ends_at,draw_at,terms,capacity,codes_per_entry) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)",[slug,source.title+' (نسخه کپی)',source.description,source.poster_file_id,source.prize_title,source.prize_description,source.prize_value,source.participation_type,source.entry_price,source.payment_methods,source.starts_at,source.ends_at,source.draw_at,source.terms,source.capacity,source.codes_per_entry]);
    await audit(ctx.from.id,'campaign.copied','campaign',created.insertId,{sourceCampaignId:id});
    await ctx.answerCbQuery('پیش‌نویس کپی ساخته شد.');
    return ctx.reply('یک پیش‌نویس مستقل از کمپین #'+id+' ساخته شد. شرکت‌کنندگان، سفارش‌ها و کدهای کمپین اصلی کپی نشده‌اند.',Markup.inlineKeyboard([[Markup.button.callback('مشاهده فهرست کمپین‌ها','admin:campaign:list')]]));
  });
  bot.action(/^admin:campaign:archive:(\d+)$/,async ctx=>{
    if(!await hasPermission(ctx.from.id,'campaign.write'))return deny(ctx);
    const id=Number(ctx.match[1]);const c=await pool.getConnection();let from;
    try{
      await c.beginTransaction();
      const [[row]]=await c.execute('SELECT status FROM campaigns WHERE id=? FOR UPDATE',[id]);
      if(!row)throw new Error('کمپین پیدا نشد.');
      if(!['draft','paused','closed'].includes(row.status))throw new Error('فقط کمپین پیش‌نویس، متوقف یا بسته قابل بایگانی است.');
      const [[pending]]=await c.execute("SELECT COUNT(*) total FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id WHERE e.campaign_id=? AND o.status IN ('awaiting_receipt','under_review','rejected')",[id]);
      if(Number(pending.total)>0)throw new Error('تا تعیین تکلیف سفارش‌های باز، بایگانی مجاز نیست.');
      from=row.status;await c.execute("UPDATE campaigns SET status='archived' WHERE id=?",[id]);
      await c.execute('INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(ctx.from.id),'campaign.archived','campaign',id,JSON.stringify({from,to:'archived'})]);
      await c.commit();
    }catch(error){await c.rollback();return ctx.answerCbQuery(error.message||'بایگانی انجام نشد.',{show_alert:true});}finally{c.release();}
    await ctx.answerCbQuery('بایگانی شد.');return ctx.reply('کمپین بایگانی شد؛ سوابق، سفارش‌ها و کدهای قبلی حفظ شده‌اند.',campaignMenu());
  });
  bot.action(/^admin:campaign:toggle:(\d+)$/,async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const id=Number(ctx.match[1]);const [[row]]=await pool.execute('SELECT status,starts_at,ends_at,(starts_at IS NOT NULL AND starts_at>UTC_TIMESTAMP()) AS not_started,(ends_at IS NOT NULL AND ends_at<=UTC_TIMESTAMP()) AS already_ended FROM campaigns WHERE id=?',[id]);if(!row)return ctx.answerCbQuery('کمپین پیدا نشد.',{show_alert:true});
    if(!['draft','scheduled','paused','open'].includes(row.status))return ctx.answerCbQuery('تغییر وضعیت این کمپین مجاز نیست.',{show_alert:true});
    if(row.status==='open'){const next='paused';await pool.execute('UPDATE campaigns SET status=? WHERE id=?',[next,id]);await audit(ctx.from.id,'campaign.status_changed','campaign',id,{from:row.status,to:next});await ctx.answerCbQuery('کمپین متوقف شد.');return ctx.reply('کمپین متوقف شد.',campaignMenu());}
    if(Number(row.already_ended)===1)return ctx.answerCbQuery('زمان پایان کمپین گذشته است؛ امکان فعال‌سازی وجود ندارد.',{show_alert:true});
    const next=Number(row.not_started)===1?'scheduled':'open';
    await pool.execute('UPDATE campaigns SET status=? WHERE id=?',[next,id]);await audit(ctx.from.id,'campaign.status_changed','campaign',id,{from:row.status,to:next});
    await ctx.answerCbQuery(next==='scheduled'?'برای شروع زمان‌بندی شد.':'کمپین فعال شد.');
    return ctx.reply(next==='scheduled'?'کمپین زمان‌بندی شد و در زمان شروع به‌صورت خودکار فعال می‌شود.':'کمپین فعال شد.',campaignMenu());
  });

  bot.action('admin:participants',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showParticipants(ctx,0);});
  bot.action(/^admin:participants:page:(\d+)$/,async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showParticipants(ctx,Number(ctx.match[1]));});
  bot.action(/^admin:participant:view:(\d+)$/,async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
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
    const buttons=[];if(await hasPermission(ctx.from.id,'participant.manage')){const action=p.status==='active'?'block':'unblock';buttons.push([Markup.button.callback(p.status==='active'?'🚫 مسدودسازی':'✅ رفع مسدودی',`admin:participant:${action}:${id}`)]);}buttons.push([Markup.button.callback('↩️ فهرست شرکت‌کنندگان','admin:participants')]);
    return ctx.reply(message,Markup.inlineKeyboard(buttons));
  });
  bot.action(/^admin:participant:(block|unblock):(\d+)$/,async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const id=Number(ctx.match[2]),action=ctx.match[1],status=action==='block'?'blocked':'active';
    const c=await pool.getConnection();try{await c.beginTransaction();const [[p]]=await c.execute('SELECT id,status FROM participants WHERE id=? FOR UPDATE',[id]);if(!p){await c.rollback();return ctx.answerCbQuery('شرکت‌کننده پیدا نشد.',{show_alert:true});}if(p.status!==status){await c.execute('UPDATE participants SET status=? WHERE id=?',[status,id]);await c.execute('INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(ctx.from.id),'participant.'+action,'participant',id,JSON.stringify({from:p.status,to:status})]);}await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}
    await ctx.answerCbQuery(action==='block'?'کاربر مسدود شد.':'مسدودی برداشته شد.');return ctx.reply(action==='block'?'حساب شرکت‌کننده مسدود شد.':'حساب شرکت‌کننده دوباره فعال شد.');
  });
  bot.action('admin:participants:export',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery('در حال آماده‌سازی خروجی...');
    const [rows]=await pool.execute('SELECT id,telegram_user_id,telegram_username,full_name,phone,instagram_handle,status,created_at FROM participants ORDER BY id DESC LIMIT 10000');
    const columns=['id','telegram_user_id','telegram_username','full_name','phone','instagram_handle','status','created_at'];
    const csv=toCsv(rows,columns);
    return ctx.replyWithDocument({source:Buffer.from(csv,'utf8'),filename:'participants-export.csv'},{caption:`خروجی شرکت‌کنندگان: ${rows.length} رکورد (حداکثر ۱۰٬۰۰۰ رکورد)`});
  });
  bot.action('admin:support',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showSupportQueue(ctx,0,'all');});
  bot.action(/^admin:support:page:(all|new|in_progress|answered|closed):(\d+)$/,async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showSupportQueue(ctx,Number(ctx.match[2]),ctx.match[1]);});
  bot.action(/^admin:support:filter:(all|new|in_progress|answered|closed)$/,async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return showSupportQueue(ctx,0,ctx.match[1]);});
  bot.action(/^admin:support:view:(\d+)$/,async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();const id=Number(ctx.match[1]);const [[t]]=await pool.execute('SELECT t.*,p.full_name,p.phone,p.telegram_user_id,p.instagram_handle FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=?',[id]);if(!t)return ctx.reply('تیکت پیدا نشد.');const [messages]=await pool.execute('SELECT sender_type,body,created_at FROM support_messages WHERE ticket_id=? ORDER BY id DESC LIMIT 12',[id]);const transcript=messages.reverse().map(m=>(m.sender_type==='admin'?'اپراتور':m.sender_type==='system'?'سیستم':'مشتری')+': '+m.body).join('\n\n').slice(0,3000);const label={new:'جدید',in_progress:'در حال بررسی',answered:'پاسخ داده‌شده',closed:'بسته'}[t.status]||t.status;const priority={low:'کم',normal:'عادی',high:'زیاد',urgent:'فوری'}[t.priority]||t.priority;return ctx.reply('🎫 تیکت '+t.ticket_number+'\nمشتری: '+t.full_name+'\nموبایل: '+t.phone+'\nتلگرام: '+t.telegram_user_id+'\nاینستاگرام: @'+t.instagram_handle+'\nموضوع: '+t.category+'\nعنوان: '+t.subject+'\nوضعیت: '+label+'\nاولویت: '+priority+'\nمسئول: '+(t.assigned_admin_id||'تخصیص‌نیافته')+'\n\n'+(transcript||'بدون پیام'),Markup.inlineKeyboard([[Markup.button.callback('✍️ پاسخ به مشتری','admin:support:reply:'+id)],[Markup.button.callback('👤 تخصیص به من','admin:support:assign:'+id)],[Markup.button.callback(t.status==='closed'?'بازگشایی':'بستن تیکت','admin:support:status:'+id+':'+(t.status==='closed'?'new':'closed'))],[Markup.button.callback('اولویت: زیاد','admin:support:priority:'+id+':high'),Markup.button.callback('اولویت: فوری','admin:support:priority:'+id+':urgent')],[Markup.button.callback('↩️ صف تیکت‌ها','admin:support')]]));});
  bot.action(/^admin:support:assign:(\d+)$/,async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const id=Number(ctx.match[1]);await pool.execute("UPDATE support_tickets SET assigned_admin_id=?,status=IF(status='new','in_progress',status) WHERE id=?",[String(ctx.from.id),id]);await audit(ctx.from.id,'support.assigned','support_ticket',id,{});await ctx.answerCbQuery('تیکت به شما تخصیص یافت.');return ctx.reply('تیکت به شما تخصیص یافت.',Markup.inlineKeyboard([[Markup.button.callback('مشاهده تیکت','admin:support:view:'+id)]]));});
  bot.action(/^admin:support:status:(\d+):(new|in_progress|answered|closed)$/,async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const id=Number(ctx.match[1]),status=ctx.match[2],c=await pool.getConnection();const labels={new:'جدید',in_progress:'در حال بررسی',answered:'پاسخ داده‌شده',closed:'بسته'};try{await c.beginTransaction();const [[ticket]]=await c.execute('SELECT t.ticket_number,p.telegram_user_id FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=? FOR UPDATE',[id]);if(!ticket)throw new Error('تیکت پیدا نشد.');await c.execute('UPDATE support_tickets SET status=? WHERE id=?',[status,id]);await c.execute('INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(ctx.from.id),'support.status_changed','support_ticket',id,JSON.stringify({status})]);await enqueueTelegramNotification({chatId:ticket.telegram_user_id,text:'وضعیت تیکت '+ticket.ticket_number+' به «'+labels[status]+'» تغییر کرد.',executor:c});await c.commit();}catch(e){await c.rollback();return ctx.answerCbQuery(e.message||'تغییر وضعیت ناموفق بود.',{show_alert:true});}finally{c.release();}await ctx.answerCbQuery('وضعیت تغییر کرد.');return ctx.reply('وضعیت تیکت به‌روزرسانی شد.');});
  bot.action(/^admin:support:priority:(\d+):(low|normal|high|urgent)$/,async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const id=Number(ctx.match[1]),priority=ctx.match[2];await pool.execute('UPDATE support_tickets SET priority=? WHERE id=?',[priority,id]);await audit(ctx.from.id,'support.priority_changed','support_ticket',id,{priority});await ctx.answerCbQuery('اولویت تغییر کرد.');return ctx.reply('اولویت تیکت تغییر کرد.');});
  bot.action(/^admin:support:reply:(\d+)$/,async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});const id=Number(ctx.match[1]);const [rows]=await pool.execute("SELECT id FROM support_tickets WHERE id=? AND status<>'closed'",[id]);if(!rows.length)return ctx.answerCbQuery('تیکت بسته است یا وجود ندارد.',{show_alert:true});await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,ticket_id) VALUES(?,'admin_reply',?) ON DUPLICATE KEY UPDATE step='admin_reply',ticket_id=VALUES(ticket_id),category=NULL",[String(ctx.from.id),id]);await ctx.answerCbQuery();return ctx.reply('پاسخ خود را به مشتری در یک پیام ارسال کنید.');});
  bot.action('admin:payments',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery();
    return showManagedOrders(ctx,'all',0);
  });
  bot.action(/^admin:payments:status:(all|awaiting_receipt|under_review|approved|rejected|cancelled|expired)$/,async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery();return showManagedOrders(ctx,ctx.match[1],0);
  });
  bot.action(/^admin:payments:page:(all|awaiting_receipt|under_review|approved|rejected|cancelled|expired):(\d+)$/,async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery();return showManagedOrders(ctx,ctx.match[1],Number(ctx.match[2]));
  });
  bot.action(/^admin:payment:order:(\d+)$/,async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery();return showManagedOrderDetail(ctx,Number(ctx.match[1]));
  });
  bot.action('admin:payment:search',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await pool.execute("INSERT INTO payment_admin_sessions(telegram_user_id,step,status_filter) VALUES(?,'search_order','all') ON DUPLICATE KEY UPDATE step=VALUES(step),status_filter='all'",[String(ctx.from.id)]);
    await ctx.answerCbQuery();return ctx.reply('شناسه سفارش، شناسه پرداخت (ISTPAY-...)، Telegram ID یا شماره موبایل را ارسال کنید.');
  });
  bot.action('admin:payment:export',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery('در حال ساخت خروجی...');
    const rows=await exportManagedOrders({limit:10000});
    const columns=['id','payment_reference','amount','currency','status','campaign_id','campaign_title','telegram_user_id','full_name','phone','instagram_handle','created_at','expires_at','approved_at'];
    return ctx.replyWithDocument({source:Buffer.from(toCsv(rows,columns),'utf8'),filename:'payment-orders.csv'},{caption:'گزارش سفارش‌ها؛ حداکثر ۱۰٬۰۰۰ سفارش اخیر. مبلغ‌ها به واحد ریال هستند.'});
  });
  bot.action('admin:payment-settings',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'payment_settings',JSON_OBJECT()) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)",[String(ctx.from.id)]);
    await ctx.answerCbQuery();
    return ctx.reply('اطلاعات کارت را در ۴ خط ارسال کنید:\nنام بانک\nشماره کارت ۱۶ رقمی\nنام صاحب کارت\nتوضیحات یا -');
  });

  bot.action('admin:stats',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();return ctx.reply('گزارش‌ها و عملکرد مالی',Markup.inlineKeyboard([[Markup.button.callback('مشاهده گزارش جامع','admin:reports')],[Markup.button.callback('بازگشت','admin:home')]]));});
  bot.action('admin:reports',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery();
    const r=await getManagementReport();
    const n=v=>Number(v||0).toLocaleString('fa-IR');
    const msg='📊 گزارش مدیریتی ربات\n\n👥 کاربران\nکل کاربران: '+n(r.users.total)+'\nفعال: '+n(r.users.active)+' | مسدود: '+n(r.users.blocked)+'\nکاربران جدید ۳۰ روز اخیر: '+n(r.newUsers.new_users_30d)+'\n\n🎯 کمپین‌ها\nکل: '+n(r.campaigns.total)+'\nفعال: '+n(r.campaigns.open_count)+' | پیش‌نویس: '+n(r.campaigns.draft_count)+' | بسته: '+n(r.campaigns.closed_count)+'\n\n🎟 شرکت‌کنندگان\nکل ورودی‌ها: '+n(r.entries.total)+'\nواجد شرایط: '+n(r.entries.eligible)+' | منتظر پرداخت: '+n(r.entries.pending_payment)+' | لغوشده: '+n(r.entries.cancelled)+'\n\n💳 امور مالی\nکل سفارش‌ها: '+n(r.payments.total)+'\nپرداخت تأییدشده: '+n(r.payments.approved_count)+' | در انتظار رسید/بررسی: '+n(r.payments.pending_count)+' | ردشده: '+n(r.payments.rejected_count)+'\nدرآمد تأییدشده: '+n(r.payments.revenue)+' ریال\nمبالغ سفارش‌های باز: '+n(r.payments.pending_amount)+' ریال\nدرآمد ۳۰ روز اخیر بر اساس تاریخ تأیید پرداخت: '+n(r.recent.revenue_30d)+' ریال\n\n🧾 رسیدها\nکل: '+n(r.receipts.total)+' | بررسی‌نشده: '+n(r.receipts.submitted)+' | تأیید: '+n(r.receipts.approved)+' | رد: '+n(r.receipts.rejected);
    const top=r.topCampaigns.length?r.topCampaigns.map((c,i)=>(i+1)+'. '+c.title+' | ورودی: '+n(c.entries)+' | تأیید پرداخت: '+n(c.paid_orders)+' | درآمد: '+n(c.revenue)+' ریال').join('\n'):'هنوز کمپینی ثبت نشده است.';
    return ctx.reply(msg+'\n\n🏆 ۱۰ کمپین برتر بر اساس درآمد\n'+top,Markup.inlineKeyboard([[Markup.button.callback('📥 خروجی CSV کمپین‌ها','admin:report:export')],[Markup.button.callback('↩️ بازگشت','admin:home')]]));
  });
  bot.action('admin:report:export',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    await ctx.answerCbQuery('در حال ساخت گزارش...');
    const report=await getManagementReport();
    const rows=reportRows(report);
    const columns=['campaign_id','title','status','type','entry_price','entries','eligible','approved_orders','revenue_irr'];
    const csv=toCsv(rows,columns);
    return ctx.replyWithDocument({source:Buffer.from(csv,'utf8'),filename:'campaign-financial-report.csv'},{caption:'گزارش کمپین‌ها؛ درآمد فقط شامل سفارش‌های تأییدشده است. مبلغ‌ها به ریال هستند.'});
  });
  bot.on('photo',async(ctx,next)=>{if(!await isAdmin(ctx))return next();const wizard=await getWizard(ctx.from.id);if(!wizard||wizard.step!=='poster')return next();const photo=ctx.message.photo.at(-1);wizard.payload.posterFileId=photo.file_id;await saveWizard(ctx.from.id,'prize_title',wizard.payload);return ctx.reply('پوستر دریافت شد. نام جایزه را وارد کنید (برای نداشتن جایزه «-»).');});
  bot.on('text',async(ctx,next)=>{
    if(!await isAdmin(ctx))return next();
    if(isConfiguredSuperAdmin(ctx.from.id)){const [pending]=await pool.execute('SELECT role FROM admin_role_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);if(pending[0]){const target=ctx.message.text.trim();if(!/^\d{5,20}$/.test(target))return ctx.reply('شناسه تلگرام باید عددی و معتبر باشد.');if(isConfiguredSuperAdmin(target))return ctx.reply('این شناسه از قبل مدیر کل تنظیم‌شده در محیط است.');const c=await pool.getConnection();try{await c.beginTransaction();const [[old]]=await c.execute('SELECT role FROM admin_users WHERE telegram_user_id=? FOR UPDATE',[target]);await c.execute('INSERT INTO admin_users(telegram_user_id,role,is_active,added_by) VALUES(?,?,1,?) ON DUPLICATE KEY UPDATE role=VALUES(role),is_active=1,added_by=VALUES(added_by)',[target,pending[0].role,String(ctx.from.id)]);await c.execute("INSERT INTO admin_role_events(target_telegram_id,actor_telegram_id,action,role_before,role_after) VALUES(?,?,?, ?,?)",[target,String(ctx.from.id),old?'role_changed':'assigned',old?.role||null,pending[0].role]);await c.execute('DELETE FROM admin_role_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}return ctx.reply('دسترسی مدیر ثبت شد: '+target+' | '+pending[0].role,Markup.inlineKeyboard([[Markup.button.callback('مدیریت مدیران','admin:roles')]]));}}
    const [[participantSearch]]=await pool.execute("SELECT step FROM admin_search_sessions WHERE telegram_user_id=? AND step='participant'",[String(ctx.from.id)]);
    if(participantSearch){const query=ctx.message.text.trim();await pool.execute('DELETE FROM admin_search_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);return showParticipants(ctx,0,query);}
    const [paymentSearch]=await pool.execute("SELECT step FROM payment_admin_sessions WHERE telegram_user_id=? AND step='search_order'",[String(ctx.from.id)]);
    if(paymentSearch[0]){const query=ctx.message.text.trim();await pool.execute('DELETE FROM payment_admin_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);const rows=await searchManagedOrders(query);if(!rows.length)return ctx.reply('سفارشی با این مشخصات پیدا نشد.');const kb=rows.map(o=>[Markup.button.callback('#'+o.id+' | '+o.payment_reference+' | '+o.full_name,'admin:payment:order:'+o.id)]);kb.push([Markup.button.callback('بازگشت به مرکز پرداخت','admin:payments')]);return ctx.reply('نتایج جست‌وجوی سفارش: '+rows.length,Markup.inlineKeyboard(kb));}
    const wizard=await getWizard(ctx.from.id);
    const [supportRows]=await pool.execute("SELECT step,ticket_id FROM support_sessions WHERE telegram_user_id=? AND step='admin_reply'",[String(ctx.from.id)]);
    if(supportRows[0]){const body=ctx.message.text.trim();if(!body||body.startsWith('/'))return ctx.reply('متن پاسخ را ارسال کنید.');if(body.length>4000)return ctx.reply('پاسخ حداکثر ۴۰۰۰ نویسه باشد.');const ticketId=supportRows[0].ticket_id;const c=await pool.getConnection();let chatId;try{await c.beginTransaction();const [[t]]=await c.execute("SELECT t.id,t.ticket_number,t.status,p.telegram_user_id FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=? FOR UPDATE",[ticketId]);if(!t||t.status==='closed')throw new Error('تیکت بسته شده یا وجود ندارد.');chatId=String(t.telegram_user_id);await c.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'admin',?,?)",[ticketId,String(ctx.from.id),body]);await c.execute("UPDATE support_tickets SET status='answered',last_message_at=UTC_TIMESTAMP() WHERE id=?",[ticketId]);await c.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await enqueueTelegramNotification({chatId,text:'پاسخ پشتیبانی برای تیکت شما:\n'+body,executor:c});await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}return ctx.reply('پاسخ ثبت شد و برای مشتری ارسال شد.',Markup.inlineKeyboard([[Markup.button.callback('مشاهده تیکت','admin:support:view:'+ticketId)]]));}
    if(!wizard)return next();
    const value=ctx.message.text.trim();const p=wizard.payload;
    if(wizard.step==='campaign_edit_value'){
      const fields={title:'title',description:'description',prize_title:'prize_title',prize_description:'prize_description',terms:'terms',entry_price:'entry_price',capacity:'capacity',codes_per_entry:'codes_per_entry',starts_at:'starts_at',ends_at:'ends_at',draw_at:'draw_at'};
      const column=fields[p.field];if(!column)return ctx.reply('درخواست ویرایش معتبر نیست.');
      let nextValue=value;
      if(['description','prize_title','prize_description','terms'].includes(column)&&value==='-')nextValue=null;
      if(column==='title'&&(value.length<3||value.length>180))return ctx.reply('عنوان باید بین ۳ تا ۱۸۰ نویسه باشد.');
      if(column==='description'&&value.length>3000)return ctx.reply('توضیحات حداکثر ۳۰۰۰ نویسه باشد.');
      if(column==='prize_title'&&value.length>180)return ctx.reply('نام جایزه حداکثر ۱۸۰ نویسه باشد.');
      if(column==='prize_description'&&value.length>2000)return ctx.reply('توضیح جایزه حداکثر ۲۰۰۰ نویسه باشد.');
      if(column==='terms'&&value.length>8000)return ctx.reply('قوانین حداکثر ۸۰۰۰ نویسه باشد.');
      if(['starts_at','ends_at','draw_at'].includes(column)){if(value==='-')nextValue=null;else{if(!/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/.test(value)||Number.isNaN(Date.parse(value.replace(' ','T')+':00Z')))return ctx.reply('زمان را به شکل YYYY-MM-DD HH:mm وارد کنید یا «-» بفرستید.');nextValue=value+':00';}}
            if(column==='entry_price'){if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>1000000000000)return ctx.reply('مبلغ باید عدد صحیح مثبت و به ریال باشد.');nextValue=Number(value);}
      if(column==='capacity'||column==='codes_per_entry'){if(!/^\d+$/.test(value))return ctx.reply('مقدار باید عدد صحیح نامنفی باشد.');nextValue=Number(value);if(column==='codes_per_entry'&&(nextValue<1||nextValue>100))return ctx.reply('تعداد کد باید بین ۱ تا ۱۰۰ باشد.');if(column==='capacity'&&nextValue>10000000)return ctx.reply('ظرفیت بیش از حد مجاز است.');if(column==='capacity'&&nextValue===0)nextValue=null;}
      const db=await pool.getConnection();try{await db.beginTransaction();const [[locked]]=await db.execute('SELECT status FROM campaigns WHERE id=? FOR UPDATE',[p.campaignId]);if(!locked||locked.status!=='draft')throw new Error('وضعیت کمپین تغییر کرده و دیگر قابل ویرایش نیست.');const [[counts]]=await db.execute('SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=?',[p.campaignId]);if(Number(counts.total)>0)throw new Error('کمپین دارای سابقه شرکت‌کننده است و ویرایش مستقیم آن مجاز نیست.');await db.execute('UPDATE campaigns SET '+column+'=? WHERE id=?',[nextValue,p.campaignId]);await db.execute('INSERT INTO admin_audit_log(admin_telegram_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(ctx.from.id),'campaign.field_updated','campaign',p.campaignId,JSON.stringify({field:column})]);await db.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[String(ctx.from.id)]);await db.commit();}catch(error){await db.rollback();return ctx.reply(error.message||'ویرایش کمپین انجام نشد.');}finally{db.release();}
      return ctx.reply('مشخصات کمپین به‌روزرسانی شد.',Markup.inlineKeyboard([[Markup.button.callback('ویرایش فیلدهای دیگر','admin:campaign:edit-menu:'+p.campaignId)],[Markup.button.callback('فهرست کمپین‌ها','admin:campaign:list')]]));
    }
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
      if(wizard.step==='price'){if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>1000000000000)throw new Error('مبلغ باید عدد صحیح مثبت و به ریال باشد.');p.price=Number(value);p.paymentMethods=['card_transfer'];return showConfirmation(ctx,p);}
    }catch(error){return ctx.reply(error.message||'ورودی نامعتبر است. دوباره تلاش کنید.');}
    return next();
  });
  bot.action('admin:campaign:confirm',async ctx=>{
    if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const wizard=await getWizard(ctx.from.id);if(!wizard||wizard.step!=='confirm')return ctx.answerCbQuery('فرایند ساخت کمپین منقضی شده است.',{show_alert:true});
    const p=wizard.payload;const slug=slugify(p.title);
    if(p.starts_at&&p.ends_at&&new Date(p.starts_at).getTime()>=new Date(p.ends_at).getTime())return ctx.answerCbQuery('زمان پایان باید بعد از شروع باشد.',{show_alert:true});if(p.draw_at&&p.ends_at&&new Date(p.draw_at).getTime()<new Date(p.ends_at).getTime())return ctx.answerCbQuery('زمان قرعه‌کشی نباید قبل از پایان کمپین باشد.',{show_alert:true});const [result]=await pool.execute("INSERT INTO campaigns(slug,title,description,poster_file_id,prize_title,prize_description,prize_value,status,participation_type,entry_price,payment_methods,starts_at,ends_at,draw_at,terms,capacity,codes_per_entry) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)",[slug,p.title,p.description,p.posterFileId||null,p.prizeTitle||null,p.prizeDescription||null,p.prizeValue||null,p.type,p.type==='paid'?p.price:0,JSON.stringify(p.paymentMethods||[]),p.starts_at,p.ends_at,p.draw_at,p.terms||null,p.capacity,p.codes]);
    await audit(ctx.from.id,'campaign.created','campaign',result.insertId,{type:p.type,title:p.title});
    await clearWizard(ctx.from.id);await ctx.answerCbQuery('کمپین ایجاد شد.');
    return ctx.reply(`کمپین «${p.title}» به‌صورت پیش‌نویس ایجاد شد. برای نمایش به کاربران، آن را از فهرست کمپین‌ها فعال کنید.`,campaignMenu());
  });
  bot.action('admin:campaign:restart',async ctx=>{if(!await isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await saveWizard(ctx.from.id,'select_type',{});await ctx.answerCbQuery();return ctx.reply('نوع کمپین را انتخاب کنید و سپس «ادامه» را بزنید:',typeMenu());});
}

async function showParticipants(ctx,page=0,query=''){
  const limit=8,offset=Math.max(0,Number(page)||0)*limit;
  const q=String(query||'').trim().slice(0,100);
  const like='%'+q.split('!').join('!!').split('%').join('!%').split('_').join('!_')+'%';
  const where=q?"WHERE p.full_name LIKE ? ESCAPE '!' OR p.phone LIKE ? ESCAPE '!' OR p.instagram_handle LIKE ? ESCAPE '!' OR CAST(p.telegram_user_id AS CHAR)=?":"";
  const params=q?[like,like,like,q,limit,offset]:[limit,offset];
  const [rows]=await pool.execute(
    "SELECT p.id,p.telegram_user_id,p.full_name,p.phone,p.instagram_handle,p.status,p.created_at,(SELECT COUNT(*) FROM campaign_entries e WHERE e.participant_id=p.id) entry_count,(SELECT COUNT(*) FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id WHERE e.participant_id=p.id) code_count FROM participants p "+where+" ORDER BY p.id DESC LIMIT ? OFFSET ?",params);
  const countParams=q?[like,like,like,q]:[];
  const [[count]]=await pool.execute("SELECT COUNT(*) total FROM participants p "+where,countParams);
  const total=Number(count.total),pages=Math.max(1,Math.ceil(total/limit));
  const buttons=rows.map(p=>[Markup.button.callback((p.status==='blocked'?'🔴 ':'🟢 ')+p.full_name+' | '+p.phone,'admin:participant:view:'+p.id)]);
  const nav=[];if(page>0)nav.push(Markup.button.callback('صفحه قبل','admin:participants:page:'+(page-1)));if(page+1<pages)nav.push(Markup.button.callback('صفحه بعد','admin:participants:page:'+(page+1)));
  if(nav.length)buttons.push(nav);
  buttons.push([Markup.button.callback('🔎 جست‌وجوی مشتری','admin:participants:search')]);
  buttons.push([Markup.button.callback('📥 خروجی CSV','admin:participants:export'),Markup.button.callback('بازگشت','admin:home')]);
  const summary=rows.map(p=>'#'+p.id+' | '+p.full_name+' | '+p.status+' | '+p.entry_count+' شرکت | '+p.code_count+' کد').join('\n');
  return ctx.reply('👥 مدیریت مشتریان\nتعداد: '+total+' | صفحه '+(page+1)+' از '+pages+(q?'\nجست‌وجو: '+q:'')+'\n\n'+(summary||'مشتری‌ای پیدا نشد.'),Markup.inlineKeyboard(buttons));
}
async function showSupportQueue(ctx,page=0,status='all'){
  const allowed=new Set(['all','new','in_progress','answered','closed']);
  const filter=allowed.has(status)?status:'all',limit=8,offset=Math.max(0,Number(page)||0)*limit;
  const where=filter==='all'?'':'WHERE t.status=?',params=filter==='all'?[limit,offset]:[filter,limit,offset];
  const [rows]=await pool.execute("SELECT t.id,t.ticket_number,t.subject,t.status,t.priority,t.assigned_admin_id,t.last_message_at,p.full_name FROM support_tickets t JOIN participants p ON p.id=t.participant_id "+where+" ORDER BY FIELD(t.priority,'urgent','high','normal','low'),t.last_message_at DESC LIMIT ? OFFSET ?",params);
  const [[count]]=await pool.execute("SELECT COUNT(*) total FROM support_tickets t "+where,filter==='all'?[]:[filter]);
  const total=Number(count.total),pages=Math.max(1,Math.ceil(total/limit));
  const buttons=[
    [Markup.button.callback('همه','admin:support:filter:all'),Markup.button.callback('جدید','admin:support:filter:new')],
    [Markup.button.callback('در حال بررسی','admin:support:filter:in_progress'),Markup.button.callback('پاسخ‌داده‌شده','admin:support:filter:answered')],
    [Markup.button.callback('بسته','admin:support:filter:closed')]
  ];
  for(const t of rows)buttons.push([Markup.button.callback((t.priority==='urgent'?'🔴 ':t.priority==='high'?'🟠 ':'')+'#'+t.ticket_number+' | '+t.full_name+' | '+t.subject,'admin:support:view:'+t.id)]);
  const nav=[];if(page>0)nav.push(Markup.button.callback('صفحه قبل','admin:support:page:'+filter+':'+(page-1)));if(page+1<pages)nav.push(Markup.button.callback('صفحه بعد','admin:support:page:'+filter+':'+(page+1)));if(nav.length)buttons.push(nav);
  buttons.push([Markup.button.callback('بازگشت','admin:home')]);
  return ctx.reply('💬 صف پشتیبانی\nفیلتر: '+filter+' | کل: '+total+' | صفحه '+(page+1)+' از '+pages+'\n\n'+(rows.length?rows.map(t=>'#'+t.ticket_number+' | '+t.full_name+' | '+t.status+' | '+t.priority+' | '+t.last_message_at).join('\n'):'تیکتی در این فیلتر وجود ندارد.'),Markup.inlineKeyboard(buttons));
}

async function showManagedOrders(ctx,status,page){
  const r=await listManagedOrders({status,page,limit:8});
  const names={all:'همه',awaiting_receipt:'منتظر رسید',under_review:'در حال بررسی',approved:'تأییدشده',rejected:'ردشده',cancelled:'لغوشده',expired:'منقضی'};
  const buttons=[
    [Markup.button.callback('همه','admin:payments:status:all'),Markup.button.callback('منتظر رسید','admin:payments:status:awaiting_receipt')],
    [Markup.button.callback('در حال بررسی','admin:payments:status:under_review'),Markup.button.callback('تأییدشده','admin:payments:status:approved')],
    [Markup.button.callback('ردشده','admin:payments:status:rejected'),Markup.button.callback('لغوشده','admin:payments:status:cancelled'),Markup.button.callback('منقضی','admin:payments:status:expired')]
  ];
  for(const o of r.rows)buttons.push([Markup.button.callback('#'+o.id+' | '+o.payment_reference+' | '+Number(o.amount).toLocaleString('fa-IR')+' ریال','admin:payment:order:'+o.id)]);
  const pages=Math.max(1,Math.ceil(r.total/r.limit));
  const nav=[];if(page>0)nav.push(Markup.button.callback('صفحه قبل','admin:payments:page:'+status+':'+(page-1)));if(page+1<pages)nav.push(Markup.button.callback('صفحه بعد','admin:payments:page:'+status+':'+(page+1)));if(nav.length)buttons.push(nav);
  buttons.push([Markup.button.callback('🔎 جست‌وجوی سفارش','admin:payment:search'),Markup.button.callback('📥 خروجی CSV','admin:payment:export')]);
  buttons.push([Markup.button.callback('بازگشت به مدیریت','admin:home')]);
  const text='🧾 مرکز سفارش‌ها و پرداخت‌ها\nفیلتر: '+names[status]+'\nتعداد کل: '+Number(r.total).toLocaleString('fa-IR')+'\nصفحه: '+(page+1)+' از '+pages+'\n\n'+(r.rows.length?r.rows.map(o=>'#'+o.id+' | '+o.full_name+' | '+o.campaign_title+' | '+Number(o.amount).toLocaleString('fa-IR')+' ریال | '+o.status).join('\n'):'سفارشی در این فیلتر وجود ندارد.');
  return ctx.reply(text,Markup.inlineKeyboard(buttons));
}
async function showManagedOrderDetail(ctx,id){
  const d=await getManagedOrderDetail(id);if(!d)return ctx.reply('سفارش پیدا نشد.');
  const o=d.order,n=v=>Number(v||0).toLocaleString('fa-IR');
  const text='🧾 جزئیات سفارش #'+o.id+'\nشناسه پرداخت: '+o.payment_reference+'\nوضعیت: '+o.status+'\nمبلغ: '+n(o.amount)+' ریال\nکمپین: '+o.campaign_title+'\nشرکت‌کننده: '+o.full_name+'\nTelegram ID: '+o.telegram_user_id+'\nموبایل: '+o.phone+'\nاینستاگرام: @'+o.instagram_handle+'\nوضعیت ورودی: '+o.entry_status+'\n\n🏦 تصویر کارت ثبت‌شده در زمان سفارش\nبانک: '+(o.bank_name||'—')+'\nشماره کارت: '+(o.card_number||'—')+'\nصاحب کارت: '+(o.card_holder||'—')+'\nزمان ایجاد: '+o.created_at+'\nانقضا: '+(o.expires_at||'—')+'\nتأیید: '+(o.approved_at||'—')+'\nدلیل رد: '+(o.rejection_reason||'—')+'\n\n🧾 رسیدها:\n'+(d.receipts.length?d.receipts.map(x=>'رسید #'+x.id+' | '+x.status+' | '+x.created_at+(x.note?' | '+x.note:'')+(x.review_note?' | یادداشت بررسی: '+x.review_note:'')).join('\n'):'بدون رسید')+'\n\n📜 رویدادها:\n'+(d.events.length?d.events.map(x=>x.event_type+' | '+x.actor_telegram_id+' | '+x.created_at+(x.details?' | '+(typeof x.details==='string'?x.details:JSON.stringify(x.details)):'')).join('\n'):'بدون رویداد');
  const buttons=[];
  for(const receipt of d.receipts.filter(x=>x.status==='submitted'))buttons.push([Markup.button.callback('تأیید رسید #'+receipt.id,'payment:approve:'+receipt.id),Markup.button.callback('رد رسید #'+receipt.id,'payment:reject:'+receipt.id)]);
  buttons.push([Markup.button.callback('بازگشت به سفارش‌ها','admin:payments')]);
  await ctx.reply(text,Markup.inlineKeyboard(buttons));
  for(const receipt of d.receipts.slice(0,5)){try{await ctx.telegram.sendPhoto(ctx.chat.id,receipt.telegram_file_id,{caption:'تصویر رسید #'+receipt.id+' | وضعیت: '+receipt.status});}catch{}}
}

async function showConfirmation(ctx,p){
  await saveWizard(ctx.from.id,'confirm',p);
  const type=p.type==='free'?'رایگان':'پولی';const price=p.type==='paid'?`\nمبلغ: ${Number(p.price).toLocaleString('fa-IR')} ریال`:'';
  const summary=`پیش‌نمایش کمپین\nعنوان: ${p.title}\nنوع: ${type}${price}\nجایزه: ${p.prizeTitle||'ثبت نشده'}\nارزش جایزه: ${p.prizeValue?Number(p.prizeValue).toLocaleString('fa-IR')+' ریال':'ثبت نشده'}\nشروع: ${p.starts_at||'تعیین نشده'}\nپایان: ${p.ends_at||'تعیین نشده'}\nقرعه‌کشی: ${p.draw_at||'تعیین نشده'}\nظرفیت: ${p.capacity??'نامحدود'}\nکد برای هر نفر: ${p.codes}\nپوستر: ${p.posterFileId?'دریافت شد':'ندارد'}\nتوضیح: ${p.description||'ندارد'}\nقوانین: ${p.terms||'ثبت نشده'}\n\nبا تأیید، کمپین به‌صورت پیش‌نویس ذخیره می‌شود.`;
  return ctx.reply(summary,Markup.inlineKeyboard([[Markup.button.callback('تأیید و ایجاد کمپین','admin:campaign:confirm')],[Markup.button.callback('لغو','admin:campaign:cancel')]]));
}
