import {randomBytes} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {config} from '../../config/env.js';
import {Markup} from 'telegraf';
import {listOpenCampaigns,getCampaignById,listParticipantCodes} from '../../modules/campaigns/campaign.service.js';
import {joinFreeCampaign} from '../../modules/entries/entry.service.js';
import {userMenuKeyboard} from '../keyboards/user.keyboard.js';
import {normalizeFullName,normalizePhone,normalizeInstagram} from '../../modules/participants/participant.service.js';
import {enqueueTelegramNotification} from '../../modules/notifications/outbox.service.js';

async function notifySupportAdmins(telegram,message,markup){
  const [rows]=await pool.execute("SELECT telegram_user_id FROM admin_users WHERE is_active=1 AND role IN ('super_admin','support_agent')");
  const recipients=new Set([...config.adminIds,...rows.map(x=>String(x.telegram_user_id))]);
  for(const id of recipients)await enqueueTelegramNotification({chatId:id,text:message,options:markup?.reply_markup?{reply_markup:markup.reply_markup}:{}});
}

export function registerUserHandlers(bot){
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
  bot.action(/^user:history:codes:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const entryId=Number(ctx.match[1]);const [rows]=await pool.execute("SELECT cc.code,c.title FROM campaign_codes cc JOIN campaign_entries e ON e.id=cc.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id JOIN participants p ON p.id=e.participant_id WHERE e.id=? AND p.telegram_user_id=? ORDER BY cc.id",[entryId,String(ctx.from.id)]);if(!rows.length)return ctx.reply('برای این شرکت کدی صادر نشده است.');return ctx.reply('کدهای کمپین «'+rows[0].title+'»:\n'+rows.map(x=>x.code).join('\n'),Markup.inlineKeyboard([[Markup.button.callback('بازگشت به سوابق','user:history')]]));});
  bot.action('user:history',async ctx=>{await ctx.answerCbQuery();return showUserHistory(ctx,0);});
  bot.action(/^user:history:page:(\d+)$/,async ctx=>{await ctx.answerCbQuery();return showUserHistory(ctx,Number(ctx.match[1]));});
  bot.action('user:codes',async ctx=>{await ctx.answerCbQuery();const rows=await listParticipantCodes(ctx.from.id);if(!rows.length)return ctx.reply('هنوز کدی برای شما صادر نشده است.',userMenuKeyboard());return ctx.reply('کدهای شما:\n'+rows.map(x=>`${x.code} — ${x.campaign_title}`).join('\n'),userMenuKeyboard());});
  bot.action('user:account',async ctx=>{await ctx.answerCbQuery();const p=ctx.state.profile;return ctx.reply(`نام: ${p.full_name}\nموبایل: ${p.phone}\nاینستاگرام: @${p.instagram_handle}`,Markup.inlineKeyboard([[Markup.button.callback('✏️ درخواست اصلاح اطلاعات','user:profile:edit')],[Markup.button.callback('بازگشت به منو','user:campaigns')]]));});

  bot.action('user:profile:edit',async ctx=>{await ctx.answerCbQuery();return ctx.reply('کدام اطلاعات را می‌خواهید اصلاح کنید؟',Markup.inlineKeyboard([[Markup.button.callback('نام و نام خانوادگی','user:profile:field:full_name')],[Markup.button.callback('شماره موبایل','user:profile:field:phone')],[Markup.button.callback('آیدی اینستاگرام','user:profile:field:instagram_handle')],[Markup.button.callback('بازگشت','user:account')]]));});
  bot.action(/^user:profile:field:(full_name|phone|instagram_handle)$/,async ctx=>{const field=ctx.match[1];await pool.execute('INSERT INTO profile_change_sessions(telegram_user_id,step) VALUES(?,?) ON DUPLICATE KEY UPDATE step=VALUES(step)',[String(ctx.from.id),field]);await ctx.answerCbQuery();if(field==='phone'){await ctx.reply('برای تغییر شماره، فقط شماره متعلق به حساب تلگرام خودتان را با دکمه زیر ارسال کنید.',Markup.keyboard([[Markup.button.contactRequest('اشتراک‌گذاری شماره من')]]).oneTime().resize());return ctx.reply('برای لغو این فرایند:',Markup.inlineKeyboard([[Markup.button.callback('لغو درخواست اصلاح','user:profile:cancel')]]));}return ctx.reply(field==='full_name'?'نام و نام خانوادگی جدید را ارسال کنید.':'آیدی اینستاگرام جدید را ارسال کنید؛ با یا بدون @.',Markup.inlineKeyboard([[Markup.button.callback('لغو درخواست اصلاح','user:profile:cancel')]]));});
  bot.action('user:profile:cancel',async ctx=>{await pool.execute('DELETE FROM profile_change_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await ctx.answerCbQuery('فرایند لغو شد.');await ctx.reply('درخواست اصلاح لغو شد.',Markup.removeKeyboard());return ctx.reply('حساب کاربری',Markup.inlineKeyboard([[Markup.button.callback('بازگشت','user:account')]]));});
  bot.on('contact',async(ctx,next)=>{const [[session]]=await pool.execute('SELECT step FROM profile_change_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);if(session?.step!=='phone')return next();if(!ctx.message.contact?.user_id||String(ctx.message.contact.user_id)!==String(ctx.from.id))return ctx.reply('این مخاطب متعلق به حساب تلگرام شما نیست. لطفاً شماره خودتان را با دکمه اشتراک‌گذاری ارسال کنید.');let phone;try{phone=normalizePhone(ctx.message.contact.phone_number);}catch(e){return ctx.reply(e.message);}return createProfileChangeRequest(ctx,'phone',phone);});
  bot.action('user:support',async ctx=>{await ctx.answerCbQuery();return ctx.reply('پشتیبانی: درخواست جدید ثبت کنید یا سوابق تیکت‌ها را ببینید.',Markup.inlineKeyboard([[Markup.button.callback('➕ ثبت درخواست جدید','support:user:new')],[Markup.button.callback('📂 تیکت‌های من','support:user:list')],[Markup.button.callback('بازگشت','user:account')]]));});
  bot.action('support:user:new',async ctx=>{await ctx.answerCbQuery();return ctx.reply('موضوع درخواست را انتخاب کنید:',Markup.inlineKeyboard([[Markup.button.callback('مالی و پرداخت','support:user:category:financial')],[Markup.button.callback('کمپین و شرکت','support:user:category:campaign')],[Markup.button.callback('مشکل فنی','support:user:category:technical')],[Markup.button.callback('امنیت حساب','support:user:category:security')],[Markup.button.callback('سایر موارد','support:user:category:other')]]));});
  bot.action(/^support:user:category:(financial|campaign|technical|security|other)$/,async ctx=>{await ctx.answerCbQuery();await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,category) VALUES(?,'new_message',?) ON DUPLICATE KEY UPDATE step='new_message',ticket_id=NULL,category=VALUES(category)",[String(ctx.from.id),ctx.match[1]]);return ctx.reply('شرح درخواست را در یک پیام ارسال کنید. لطفاً اطلاعات حساس بانکی یا رمز عبور نفرستید.');});
  bot.action('support:user:list',async ctx=>{await ctx.answerCbQuery();const [rows]=await pool.execute('SELECT t.id,t.ticket_number,t.subject,t.status,t.priority,t.last_message_at FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE p.telegram_user_id=? ORDER BY t.last_message_at DESC LIMIT 20',[String(ctx.from.id)]);if(!rows.length)return ctx.reply('هنوز تیکتی ثبت نکرده‌اید.');for(const t of rows)await ctx.reply('#'+t.ticket_number+' | '+t.subject+'\nوضعیت: '+({new:'جدید',in_progress:'در حال بررسی',answered:'پاسخ داده‌شده',closed:'بسته'}[t.status]||t.status)+' | اولویت: '+t.priority,Markup.inlineKeyboard([[Markup.button.callback('مشاهده و پاسخ','support:user:view:'+t.id)]]));});
  bot.action(/^support:user:view:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const id=Number(ctx.match[1]);const [[ticket]]=await pool.execute('SELECT t.id,t.ticket_number,t.subject,t.category,t.status,t.priority FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=? AND p.telegram_user_id=?',[id,String(ctx.from.id)]);if(!ticket)return ctx.reply('تیکت پیدا نشد.');const [messages]=await pool.execute('SELECT sender_type,body,created_at FROM support_messages WHERE ticket_id=? ORDER BY id DESC LIMIT 10',[id]);const body=messages.reverse().map(m=>(m.sender_type==='admin'?'پشتیبانی':'شما')+': '+m.body).join('\n\n').slice(0,3200);const buttons=[];if(ticket.status!=='closed')buttons.push([Markup.button.callback('✍️ ارسال پاسخ','support:user:reply:'+id)]);return ctx.reply('تیکت #'+ticket.ticket_number+'\nموضوع: '+ticket.subject+'\nوضعیت: '+ticket.status+'\n\n'+(body||'بدون پیام'),Markup.inlineKeyboard([...buttons,[Markup.button.callback('فهرست تیکت‌ها','support:user:list')]]));});
  bot.action(/^support:user:reply:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const id=Number(ctx.match[1]);const [r]=await pool.execute("SELECT t.id FROM support_tickets t JOIN participants p ON p.id=t.participant_id WHERE t.id=? AND p.telegram_user_id=? AND t.status<>'closed'",[id,String(ctx.from.id)]);if(!r.length)return ctx.reply('این تیکت برای پاسخ‌گویی در دسترس نیست.');await pool.execute("INSERT INTO support_sessions(telegram_user_id,step,ticket_id) VALUES(?,'user_reply',?) ON DUPLICATE KEY UPDATE step='user_reply',ticket_id=VALUES(ticket_id),category=NULL",[String(ctx.from.id),id]);return ctx.reply('پاسخ خود را در یک پیام ارسال کنید.');});
  bot.on('text',async(ctx,next)=>{if(!ctx.state.profile)return next();const [[profileSession]]=await pool.execute('SELECT step FROM profile_change_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);if(profileSession&&['full_name','instagram_handle'].includes(profileSession.step)){let value;try{value=profileSession.step==='full_name'?normalizeFullName(ctx.message.text):normalizeInstagram(ctx.message.text);}catch(e){return ctx.reply(e.message);}return createProfileChangeRequest(ctx,profileSession.step,value);}const [sessions]=await pool.execute('SELECT step,ticket_id,category FROM support_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);const session=sessions[0];if(!session)return next();const body=ctx.message.text.trim();if(!body||body.startsWith('/'))return ctx.reply('لطفاً متن پیام را ارسال کنید.');if(body.length>4000)return ctx.reply('پیام حداکثر ۴۰۰۰ نویسه باشد.');if(session.step==='new_message'){const [[participant]]=await pool.execute('SELECT id FROM participants WHERE telegram_user_id=?',[String(ctx.from.id)]);const ticketNo='SUP-'+randomBytes(4).toString('hex').toUpperCase();const c=await pool.getConnection();let id;try{await c.beginTransaction();const [r]=await c.execute("INSERT INTO support_tickets(ticket_number,participant_id,category,subject,status) VALUES(?,?,?,?,'new')",[ticketNo,participant.id,session.category,body.slice(0,180)]);id=r.insertId;await c.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'participant',?,?)",[id,String(ctx.from.id),body]);await c.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}await notifySupportAdmins(ctx.telegram,'🎫 تیکت جدید '+ticketNo+'\\nموضوع: '+session.category+'\\nمشتری: '+ctx.state.profile.full_name+'\\nشرح: '+body.slice(0,700),Markup.inlineKeyboard([[Markup.button.callback('بررسی تیکت','admin:support:view:'+id)]]));return ctx.reply('درخواست شما ثبت شد.\nشماره پیگیری: '+ticketNo+'\nپاسخ از همین بخش برای شما ارسال می‌شود.',Markup.inlineKeyboard([[Markup.button.callback('مشاهده تیکت','support:user:view:'+id)],[Markup.button.callback('بازگشت','user:support')]]));}if(session.step==='user_reply'){const c=await pool.getConnection();try{await c.beginTransaction();const [[ticket]]=await c.execute("SELECT id,status FROM support_tickets WHERE id=? AND participant_id=(SELECT id FROM participants WHERE telegram_user_id=?) FOR UPDATE",[session.ticket_id,String(ctx.from.id)]);if(!ticket||ticket.status==='closed')throw new Error('این تیکت بسته شده یا در دسترس نیست.');await c.execute("INSERT INTO support_messages(ticket_id,sender_type,sender_telegram_id,body) VALUES(?,'participant',?,?)",[ticket.id,String(ctx.from.id),body]);await c.execute("UPDATE support_tickets SET status='new',last_message_at=UTC_TIMESTAMP() WHERE id=?",[ticket.id]);await c.execute('DELETE FROM support_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}const [[ticketMeta]]=await pool.execute('SELECT ticket_number FROM support_tickets WHERE id=?',[session.ticket_id]);await notifySupportAdmins(ctx.telegram,'💬 پاسخ جدید مشتری در تیکت '+(ticketMeta?.ticket_number||session.ticket_id)+'\\nمشتری: '+ctx.state.profile.full_name,Markup.inlineKeyboard([[Markup.button.callback('مشاهده تیکت','admin:support:view:'+session.ticket_id)]]));return ctx.reply('پاسخ شما به تیکت اضافه شد.');}return next();});
}
async function showUserHistory(ctx,page=0){
  const limit=8,offset=Math.max(0,Number(page)||0)*limit;
  const [rows]=await pool.execute("SELECT e.id entry_id,e.status entry_status,e.created_at,c.id campaign_id,c.title,c.status campaign_status,(SELECT COUNT(*) FROM campaign_codes cc WHERE cc.campaign_entry_id=e.id) code_count,(SELECT COUNT(*) FROM payment_orders po WHERE po.campaign_entry_id=e.id) order_count,(SELECT po.status FROM payment_orders po WHERE po.campaign_entry_id=e.id ORDER BY po.id DESC LIMIT 1) latest_payment_status FROM campaign_entries e JOIN participants p ON p.id=e.participant_id JOIN campaigns c ON c.id=e.campaign_id WHERE p.telegram_user_id=? ORDER BY e.id DESC LIMIT ? OFFSET ?",[String(ctx.from.id),limit+1,offset]);
  const hasNext=rows.length>limit,visible=rows.slice(0,limit);
  if(!visible.length)return ctx.reply('هنوز در هیچ کمپینی شرکت نکرده‌اید.',userMenuKeyboard());
  for(const row of visible){
    const status={eligible:'واجد شرایط',pending_payment:'در انتظار پرداخت',cancelled:'لغوشده',disqualified:'سلب صلاحیت'}[row.entry_status]||row.entry_status;
    await ctx.reply('🎁 '+row.title+'\nوضعیت شرکت: '+status+'\nکدهای صادرشده: '+Number(row.code_count)+'\nسفارش‌ها: '+Number(row.order_count)+'\nآخرین وضعیت پرداخت: '+(row.latest_payment_status||'ندارد')+'\nتاریخ ثبت: '+row.created_at,Markup.inlineKeyboard([[Markup.button.callback('مشاهده کدهای این کمپین','user:history:codes:'+row.entry_id)]]));
  }
  const nav=[];if(page>0)nav.push(Markup.button.callback('صفحه قبل','user:history:page:'+(page-1)));if(hasNext)nav.push(Markup.button.callback('صفحه بعد','user:history:page:'+(page+1)));
  if(nav.length)await ctx.reply('صفحه سوابق شرکت',Markup.inlineKeyboard([nav]));
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

async function createProfileChangeRequest(ctx,field,value){
  const c=await pool.getConnection();let requestId;
  try{
    await c.beginTransaction();
    const [[participant]]=await c.execute('SELECT id FROM participants WHERE telegram_user_id=? FOR UPDATE',[String(ctx.from.id)]);
    if(!participant)throw new Error('پروفایل کاربری پیدا نشد.');
    const [[pending]]=await c.execute("SELECT id FROM profile_change_requests WHERE participant_id=? AND status='pending' LIMIT 1",[participant.id]);
    if(pending){await c.rollback();return ctx.reply('یک درخواست اصلاح اطلاعات شما هنوز در انتظار بررسی است. پس از تعیین تکلیف آن می‌توانید درخواست جدید ثبت کنید.');}
    const [result]=await c.execute("INSERT INTO profile_change_requests(participant_id,requested_profile,status) VALUES(?,?,'pending')",[participant.id,JSON.stringify({field,value})]);
    requestId=result.insertId;
    await c.execute('DELETE FROM profile_change_sessions WHERE telegram_user_id=?',[String(ctx.from.id)]);
    await c.commit();
  }catch(error){await c.rollback();throw error;}finally{c.release();}
  const [admins]=await pool.execute("SELECT telegram_user_id FROM admin_users WHERE is_active=1 AND role='super_admin'");
  const recipients=new Set([...config.adminIds,...admins.map(x=>String(x.telegram_user_id))]);
  for(const id of recipients)await enqueueTelegramNotification({chatId:id,text:'درخواست اصلاح پروفایل جدید\nمشتری: '+ctx.state.profile.full_name+'\nفیلد: '+field+'\nمقدار درخواستی: '+value,options:{reply_markup:Markup.inlineKeyboard([[Markup.button.callback('بررسی درخواست','admin:profile-request:view:'+requestId)]]).reply_markup}});
  await ctx.reply('درخواست اصلاح اطلاعات ثبت شد. پس از بررسی مدیریت، نتیجه به شما اطلاع داده می‌شود.',Markup.removeKeyboard());
  return ctx.reply('درخواست شما در صف بررسی است.',Markup.inlineKeyboard([[Markup.button.callback('حساب کاربری','user:account')],[Markup.button.callback('پشتیبانی','user:support')]]));
}
