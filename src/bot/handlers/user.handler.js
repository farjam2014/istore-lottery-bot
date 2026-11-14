import {randomBytes} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {config} from '../../config/env.js';
import {Markup} from 'telegraf';
import {listOpenCampaigns,getCampaignById,listParticipantCodes} from '../../modules/campaigns/campaign.service.js';
import {joinFreeCampaign} from '../../modules/entries/entry.service.js';
import {userMenuKeyboard} from '../keyboards/user.keyboard.js';

async function notifySupportAdmins(bot,message,markup){
  const [rows]=await pool.execute("SELECT telegram_user_id FROM admin_users WHERE is_active=1 AND role IN ('super_admin','support_agent')");
  const recipients=new Set([...config.adminIds,...rows.map(x=>String(x.telegram_user_id))]);
  for(const id of recipients)await bot.telegram.sendMessage(String(id),message,markup).catch(()=>{});
}
\nexport function registerUserHandlers(bot){
  bot.action('user:campaigns',async ctx=>{await ctx.answerCbQuery();return showCampaignPage(ctx,0);});
  bot.action(/^user:campaigns:page:(\d+)$/,async ctx=>{await ctx.answerCbQuery();return showCampaignPage(ctx,Number(ctx.match[1]));});
  bot.action(/^campaign:view:(\d+)$/,async ctx=>{
    await ctx.answerCbQuery();
    const campaign=await getCampaignById(Number(ctx.match[1]));
    if(!campaign||campaign.status!=='open')return ctx.reply('این کمپین دیگر در دسترس نیست.');
    const lines=[
      '🎁 '+campaign.title,
      campaign.description||'توضیحی ثبت نشده است.',
      campaign.prize_title?'جایزه: '+campaign.prize_title:null,
      campaign.prize_description||null,
      campaign.prize_value?'ارزش تقریبی جایزه: '+Number(campaign.prize_value).toLocaleString('fa-IR')+' ریال':null,
      'نوع شرکت: '+(campaign.participation_type==='free'?'رایگان':'پولی'),
      campaign.participation_type==='paid'?'هزینه شرکت: '+Number(campaign.entry_price||0).toLocaleString('fa-IR')+' ریال':'شرکت رایگان',
      campaign.starts_at?'شروع: '+campaign.starts_at:null,
      campaign.ends_at?'پایان: '+campaign.ends_at:null,
      campaign.draw_at?'زمان قرعه‌کشی: '+campaign.draw_at:null,
      campaign.capacity?'ظرفیت کل: '+campaign.capacity+' | ثبت‌نام/رزرو: '+Number(campaign.participant_count||0):'ظرفیت: نامحدود',
      campaign.terms?'قوانین و شرایط:\n'+campaign.terms:null
    ].filter(Boolean);
    const buttons=campaign.participation_type==='free'?[[Markup.button.callback('شرکت در کمپین','campaign:join:'+campaign.id)]]:[[Markup.button.callback('ثبت سفارش و پرداخت','payment:start:'+campaign.id)]];
    buttons.push([Markup.button.callback('بازگشت به کمپین‌ها','user:campaigns')]);
    if(campaign.poster_file_id)await ctx.replyWithPhoto(campaign.poster_file_id,{caption:'پوستر کمپین: '+campaign.title});
    return ctx.reply(lines.join('\n\n'),Markup.inlineKeyboard(buttons));
  });
  bot.action(/^campaign:join:(\d+)$/,async ctx=>{
    await ctx.answerCbQuery();
    try{
      const result=await joinFreeCampaign({telegramUserId:ctx.from.id,campaignId:Number(ctx.match[1])});
      const heading=result.alreadyJoined?'شما قبلاً در این کمپین ثبت‌نام شده‌اید.':'ثبت‌نام شما با موفقیت انجام شد.';
      return ctx.reply(`${heading}\n\nکدهای اختصاصی شما:\n${result.codes.join('\n')}`,userMenuKeyboard());
    }catch(error){return ctx.reply(error.message||'ثبت‌نام در کمپین انجام نشد.',userMenuKeyboard());}
  });
  bot.action('user:codes',async ctx=>{await ctx.answerCbQuery();const rows=await listParticipantCodes(ctx.from.id);if(!rows.length)return ctx.reply('هنوز کدی برای شما صادر نشده است.',userMenuKeyboard());return ctx.reply('کدهای شما:\n'+rows.map(x=>`${x.code} — ${x.campaign_title}`).join('\n'),userMenuKeyboard());});
  bot.action('user:account',async ctx=>{await ctx.answerCbQuery();const p=ctx.state.profile;return ctx.reply(`نام: ${p.full_name}\nموبایل: ${p.phone}\nاینستاگرام: @${p.instagram_handle}`,userMenuKeyboard());});
  bot.action('user:support',async ctx=>{await ctx.answerCbQuery();return ctx.reply('پشتیبانی: درخواست جدید ثبت کنید یا سوابق تیکت‌ها را ببینید.',Markup.inlineKeyboard([[Markup.button.callback('➕ ثبت درخواست جدید','support:user:new')],[Markup.button.callback('📂 تیکت‌های من','support:user:list')],[Markup.button.callback('بازگشت','user:account')]]));});
  bot.action('support:user:new',async ctx=>{await ctx.answerCbQuery();return ctx.reply('موضوع درخواست را انتخاب کنید:',Markup.inlineKeyboard([[Markup.button.callback('مالی و پرداخت','support:user:category:financial')],[Markup.button.callback('کمپین و شرکت','support:user:category:campaign')],[Markup.button.callback('مشکل فنی','support:user:category:technical')],[Markup.button.callback('امنیت حساب','support:user:category:security')],[Markup.button.callback('سایر موارد','support:user:category:other')]]));});
  bot.action(/^support:user:category:(financial|campaign|technical|security|other)$/,async ctx=>{await ctx.answerCbQuery();await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,category) VALUES(?,'new_message',?) ON DUPLICATE KEY UPDATE step='new_message',ticket_id=NULL,category=VALUES(category)",[String(ctx.from.id),ctx.match[1]]);return ctx.reply('شرح درخواست را در یک پیام ارسال کنید. لطفاً اطلاعات حساس بانکی یا رمز عبور نفرستید.');});
  bot.action('support:user:list',async ctx=>{await ctx.answerCbQuery();const [rows]=await pool.execute('SELECT t.id,t.ticket_number,t.subject,t.status,t.priority,t.last_message_at FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE p.telegram_user_id=? ORDER BY t.last_message_at DESC LIMIT 20',[String(ctx.from.id)]);if(!rows.length)return ctx.reply('هنوز تیکتی ثبت نکرده‌اید.');for(const t of rows)await ctx.reply('#'+t.ticket_number+' | '+t.subject+'\nوضعیت: '+({new:'جدید',in_progress:'در حال بررسی',answered:'پاسخ داده‌شده',closed:'بسته'}[t.status]||t.status)+' | اولویت: '+t.priority,Markup.inlineKeyboard([[Markup.button.callback('مشاهده و پاسخ','support:user:view:'+t.id)]]));});
  bot.action(/^support:user:view:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const id=Number(ctx.match[1]);const [[ticket]]=await pool.execute('SELECT t.id,t.ticket_number,t.subject,t.category,t.status,t.priority FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=? AND p.telegram_user_id=?',[id,String(ctx.from.id)]);if(!ticket)return ctx.reply('تیکت پیدا نشد.');const [messages]=await pool.execute('SELECT sender_type,body,created_at FROM support_messages WHERE ticket_id=? ORDER BY id DESC LIMIT 10',[id]);const body=messages.reverse().map(m=>(m.sender_type==='admin'?'پشتیبانی':'شما')+': '+m.body).join('\n\n').slice(0,3200);const buttons=[];if(ticket.status!=='closed')buttons.push([Markup.button.callback('✍️ ارسال پاسخ','support:user:reply:'+id)]);return ctx.reply('تیکت #'+ticket.ticket_number+'\nموضوع: '+ticket.subject+'\nوضعیت: '+ticket.status+'\n\n'+(body||'بدون پیام'),Markup.inlineKeyboard([...buttons,[Markup.button.callback('فهرست تیکت‌ها','support:user:list')]]));});
  bot.action(/^support:user:reply:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const id=Number(ctx.match[1]);const [r]=await pool.execute("SELECT t.id FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=? AND p.telegram_user_id=? AND t.status<>'closed'",[id,String(ctx.from.id)]);if(!r.length)return ctx.reply('این تیکت برای پاسخ‌گویی در دسترس نیست.');await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,ticket_id) VALUES(?,'user_reply',?) ON DUPLICATE KEY UPDATE step='user_reply',ticket_id=VALUES(ticket_id),category=NULL",[String(ctx.from.id),id]);return ctx.reply('پاسخ خود را در یک پیام ارسال کنید.');});
  bot.on('text',async(ctx,next)=>{if(!ctx.state.profile)return next();const [sessions]=await pool.execute('SELECT step,ticket_id,category FROM support_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);const session=sessions[0];if(!session)return next();const body=ctx.message.text.trim();if(!body||body.startsWith('/'))return ctx.reply('لطفاً متن پیام را ارسال کنید.');if(body.length>4000)return ctx.reply('پیام حداکثر ۴۰۰۰ نویسه باشد.');if(session.step==='new_message'){const [[participant]]=await pool.execute('SELECT id FROM participants WHERE telegram_user_id=?',[String(ctx.from.id)]);const ticketNo='SUP-'+randomBytes(4).toString('hex').toUpperCase();const c=await pool.getConnection();let id;try{await c.beginTransaction();const [r]=await c.execute("INSERT INTO support_tickets(ticket_number,participant_id,category,subject,status) VALUES(?,?,?,?,'new')",[ticketNo,participant.id,session.category,body.slice(0,180)]);id=r.insertId;await c.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'participant',?,?)",[id,String(ctx.from.id),body]);await c.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}await notifySupportAdmins(ctx.telegram,'🎫 تیکت جدید '+ticketNo+'\\nموضوع: '+session.category+'\\nمشتری: '+ctx.state.profile.full_name+'\\nشرح: '+body.slice(0,700),Markup.inlineKeyboard([[Markup.button.callback('بررسی تیکت','admin:support:view:'+id)]]));return ctx.reply('درخواست شما ثبت شد.\nشماره پیگیری: '+ticketNo+'\nپاسخ از همین بخش برای شما ارسال می‌شود.',Markup.inlineKeyboard([[Markup.button.callback('مشاهده تیکت','support:user:view:'+id)],[Markup.button.callback('بازگشت','user:support')]]));}if(session.step==='user_reply'){const c=await pool.getConnection();try{await c.beginTransaction();const [[ticket]]=await c.execute("SELECT id,status FROM support_tickets WHERE id=? AND participant_id=(SELECT id FROM participants WHERE telegram_user_id=?) FOR UPDATE",[session.ticket_id,String(ctx.from.id)]);if(!ticket||ticket.status==='closed')throw new Error('این تیکت بسته شده یا در دسترس نیست.');await c.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'participant',?,?)",[ticket.id,String(ctx.from.id),body]);await c.execute("UPDATE support_tickets SET status='new',last_message_at=UTC_TIMESTAMP() WHERE id=?",[ticket.id]);await c.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}const [[ticketMeta]]=await pool.execute('SELECT ticket_number FROM support_tickets WHERE id=?',[session.ticket_id]);await notifySupportAdmins(ctx.telegram,'💬 پاسخ جدید مشتری در تیکت '+(ticketMeta?.ticket_number||session.ticket_id)+'\\nمشتری: '+ctx.state.profile.full_name,Markup.inlineKeyboard([[Markup.button.callback('مشاهده تیکت','admin:support:view:'+session.ticket_id)]]));return ctx.reply('پاسخ شما به تیکت اضافه شد.');}return next();});
}
async function showCampaignPage(ctx,page){
  const limit=6;const rows=await listOpenCampaigns({limit:limit+1,offset:page*limit});const hasNext=rows.length>limit;const visible=rows.slice(0,limit);
  if(!visible.length)return ctx.reply('در حال حاضر کمپین فعالی وجود ندارد.',userMenuKeyboard());
  for(const campaign of visible){
    const description=[`🎁 ${campaign.title}`,campaign.description||'',campaign.participation_type==='free'?'شرکت رایگان':`هزینه: ${Number(campaign.entry_price||0).toLocaleString('fa-IR')} ریال`,`شرکت‌کنندگان: ${Number(campaign.participant_count||0).toLocaleString('fa-IR')}`].filter(Boolean).join('\n');
    await ctx.reply(description,Markup.inlineKeyboard([[Markup.button.callback('جزئیات',`campaign:view:${campaign.id}`)]]));
  }
  const nav=[];if(page>0)nav.push(Markup.button.callback('صفحه قبل',`user:campaigns:page:${page-1}`));if(hasNext)nav.push(Markup.button.callback('صفحه بعد',`user:campaigns:page:${page+1}`));
  if(nav.length)await ctx.reply('صفحه کمپین‌ها',Markup.inlineKeyboard([nav]));
}
