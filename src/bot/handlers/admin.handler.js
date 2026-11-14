import {randomBytes} from 'node:crypto';
import {config} from '../../config/env.js';
import {pool} from '../../database/pool.js';
import {Markup} from 'telegraf';
import {listPendingReceipts} from '../../modules/payments/payment.service.js';
import {toCsv} from '../../shared/csv.js';

const isAdmin=ctx=>config.adminIds.has(String(ctx.from?.id));
const menu=()=>Markup.inlineKeyboard([
  [Markup.button.callback('🎯 مدیریت کمپین‌ها','admin:campaigns')],
  [Markup.button.callback('👥 مدیریت شرکت‌کنندگان','admin:participants')],
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
    const wizard=await getWizard(ctx.from.id);if(!wizard)return next();
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
