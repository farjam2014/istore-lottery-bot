import {randomBytes} from 'node:crypto';
import {config} from '../../config/env.js';
import {pool} from '../../database/pool.js';
import {Markup} from 'telegraf';

const isAdmin=ctx=>config.adminIds.has(String(ctx.from?.id));
const menu=()=>Markup.inlineKeyboard([
  [Markup.button.callback('🎯 مدیریت کمپین‌ها','admin:campaigns')],
  [Markup.button.callback('📊 آمار کاربران','admin:stats')]
]);
const campaignMenu=()=>Markup.inlineKeyboard([
  [Markup.button.callback('➕ افزودن کمپین','admin:campaign:add')],
  [Markup.button.callback('📋 فهرست کمپین‌ها','admin:campaign:list')],
  [Markup.button.callback('↩️ بازگشت به مدیریت','admin:home')]
]);
const typeMenu=()=>Markup.inlineKeyboard([
  [Markup.button.callback('🟢 رایگان','admin:campaign:type:free')],
  [Markup.button.callback('💳 پولی','admin:campaign:type:paid')],
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
  bot.action('admin:campaign:add',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await clearWizard(ctx.from.id);await ctx.answerCbQuery();return ctx.reply('نوع کمپین جدید را انتخاب کنید:',typeMenu());});
  bot.action(/^admin:campaign:type:(free|paid)$/,async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const type=ctx.match[1];await saveWizard(ctx.from.id,'title',{type});await ctx.answerCbQuery();
    return ctx.reply(type==='free'?'کمپین رایگان انتخاب شد. عنوان کمپین را ارسال کنید.':'کمپین پولی انتخاب شد. عنوان کمپین را ارسال کنید.');
  });
  bot.action('admin:campaign:cancel',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await clearWizard(ctx.from.id);await ctx.answerCbQuery('لغو شد.');return ctx.reply('ساخت کمپین لغو شد.',campaignMenu());});
  bot.action('admin:campaign:list',async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();
    const [rows]=await pool.execute('SELECT id,title,status,participation_type,entry_price FROM campaigns ORDER BY id DESC LIMIT 20');
    if(!rows.length)return ctx.reply('هنوز کمپینی ایجاد نشده است.',campaignMenu());
    for(const c of rows){const label={draft:'پیش‌نویس',scheduled:'زمان‌بندی‌شده',open:'فعال',paused:'متوقف',closed:'بسته',drawn:'قرعه‌کشی‌شده',archived:'بایگانی'}[c.status]||c.status;await ctx.reply(`#${c.id} — ${c.title}\nنوع: ${c.participation_type==='free'?'رایگان':'پولی'}\nوضعیت: ${label}${c.participation_type==='paid'?'\nمبلغ: '+Number(c.entry_price).toLocaleString('fa-IR')+' ریال':''}`,Markup.inlineKeyboard([[Markup.button.callback(c.status==='open'?'⏸ توقف کمپین':'▶️ فعال‌سازی کمپین',`admin:campaign:toggle:${c.id}`)],[Markup.button.callback('بازگشت','admin:campaigns')]]));}
  });
  bot.action(/^admin:campaign:toggle:(\d+)$/,async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const id=Number(ctx.match[1]);const [[row]]=await pool.execute('SELECT status FROM campaigns WHERE id=?',[id]);if(!row)return ctx.answerCbQuery('کمپین پیدا نشد.',{show_alert:true});
    const next=row.status==='open'?'paused':'open';if(!['draft','paused','open'].includes(row.status))return ctx.answerCbQuery('تغییر وضعیت این کمپین مجاز نیست.',{show_alert:true});
    await pool.execute('UPDATE campaigns SET status=? WHERE id=?',[next,id]);await audit(ctx.from.id,'campaign.status_changed','campaign',id,{from:row.status,to:next});await ctx.answerCbQuery('وضعیت به‌روزرسانی شد.');return ctx.reply(next==='open'?'کمپین فعال شد.':'کمپین متوقف شد.',campaignMenu());
  });
  bot.action('admin:stats',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await ctx.answerCbQuery();const [[u]]=await pool.query('SELECT COUNT(*) total FROM participants');const [[c]]=await pool.query('SELECT COUNT(*) total FROM campaigns');const [[e]]=await pool.query('SELECT COUNT(*) total FROM campaign_entries');return ctx.reply(`کاربران: ${u.total}\nکمپین‌ها: ${c.total}\nورودی‌های کمپین: ${e.total}`,menu());});
  bot.on('text',async(ctx,next)=>{
    if(!isAdmin(ctx))return next();
    const wizard=await getWizard(ctx.from.id);if(!wizard)return next();
    const value=ctx.message.text.trim();const p=wizard.payload;
    try{
      if(wizard.step==='title'){if(value.length<3||value.length>180)throw new Error('عنوان باید بین ۳ تا ۱۸۰ نویسه باشد.');p.title=value;await saveWizard(ctx.from.id,'description',p);return ctx.reply('توضیح کمپین را بنویسید. برای بدون توضیح، «-» ارسال کنید.');}
      if(wizard.step==='description'){p.description=value==='-'?'':value;if(p.description.length>3000)throw new Error('توضیح حداکثر ۳۰۰۰ نویسه باشد.');await saveWizard(ctx.from.id,'capacity',p);return ctx.reply('ظرفیت کمپین را به عدد وارد کنید. عدد ۰ یعنی نامحدود.');}
      if(wizard.step==='capacity'){if(!/^\d+$/.test(value)||Number(value)>10000000)throw new Error('ظرفیت باید عدد صحیح باشد؛ ۰ یعنی نامحدود.');p.capacity=Number(value)||null;await saveWizard(ctx.from.id,'codes',p);return ctx.reply('تعداد کد برای هر شرکت‌کننده را وارد کنید (۱ تا ۱۰۰).');}
      if(wizard.step==='codes'){if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>100)throw new Error('تعداد کد باید بین ۱ تا ۱۰۰ باشد.');p.codes=Number(value);if(p.type==='paid'){await saveWizard(ctx.from.id,'price',p);return ctx.reply('مبلغ شرکت در کمپین را به ریال وارد کنید (عدد صحیح مثبت).');}return showConfirmation(ctx,p);}
      if(wizard.step==='price'){if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>1000000000000)throw new Error('مبلغ باید عدد صحیح مثبت و به ریال باشد.');p.price=Number(value);return showConfirmation(ctx,p);}
    }catch(error){return ctx.reply(error.message||'ورودی نامعتبر است. دوباره تلاش کنید.');}
    return next();
  });
  bot.action('admin:campaign:confirm',async ctx=>{
    if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});
    const wizard=await getWizard(ctx.from.id);if(!wizard||wizard.step!=='confirm')return ctx.answerCbQuery('فرایند ساخت کمپین منقضی شده است.',{show_alert:true});
    const p=wizard.payload;const slug=slugify(p.title);
    const [result]=await pool.execute("INSERT INTO campaigns(slug,title,description,status,participation_type,entry_price,capacity,codes_per_entry) VALUES(?,?,?,'draft',?,?,?,?)",[slug,p.title,p.description,p.type,p.type==='paid'?p.price:0,p.capacity,p.codes]);
    await audit(ctx.from.id,'campaign.created','campaign',result.insertId,{type:p.type,title:p.title});
    await clearWizard(ctx.from.id);await ctx.answerCbQuery('کمپین ایجاد شد.');
    return ctx.reply(`کمپین «${p.title}» به‌صورت پیش‌نویس ایجاد شد. برای نمایش به کاربران، آن را از فهرست کمپین‌ها فعال کنید.`,campaignMenu());
  });
  bot.action('admin:campaign:restart',async ctx=>{if(!isAdmin(ctx))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await clearWizard(ctx.from.id);await ctx.answerCbQuery();return ctx.reply('ساخت کمپین جدید:',typeMenu());});
}
async function showConfirmation(ctx,p){
  await saveWizard(ctx.from.id,'confirm',p);
  const type=p.type==='free'?'رایگان':'پولی';const price=p.type==='paid'?`\nمبلغ: ${Number(p.price).toLocaleString('fa-IR')} ریال`:'';
  const summary=`پیش‌نمایش کمپین\nعنوان: ${p.title}\nنوع: ${type}${price}\nظرفیت: ${p.capacity??'نامحدود'}\nکد برای هر نفر: ${p.codes}\nتوضیح: ${p.description||'ندارد'}\n\nبا تأیید، کمپین به‌صورت پیش‌نویس ذخیره می‌شود.`;
  return ctx.reply(summary,Markup.inlineKeyboard([[Markup.button.callback('تأیید و ایجاد کمپین','admin:campaign:confirm')],[Markup.button.callback('لغو','admin:campaign:cancel')]]));
}
