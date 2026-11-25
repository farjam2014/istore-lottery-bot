import {Markup} from 'telegraf';
import {config} from '../../config/env.js';
import {logger} from '../../shared/logger.js';
import {hasPermission} from '../../modules/admin/admin-role.service.js';
import {pool} from '../../database/pool.js';
import {paymentApproveAction,paymentRejectAction} from '../../modules/payments/payment-callbacks.js';
import {createOrGetOrder,getUserCampaignCodeAllowance,submitReceipt,listUserOrders,countUserOrders,getUserOrder,listPendingReceipts,reviewReceipt,getPaymentSettings,updatePaymentSettings,recordPaymentCardDelivery} from '../../modules/payments/payment.service.js';
import {formatTehranDateTime} from '../../shared/datetime.js';
import {screenReply} from '../helpers/screen-reply.js';
const can=async(ctx,permission)=>hasPermission(ctx.from?.id,permission);
const money=n=>Number(n||0).toLocaleString('fa-IR');
const QUANTITY_PAGE_SIZE=10;

export function isStalePaymentReceiptUpdate(updateId,lastUpdateId){
  const current=Number(updateId);
  if(!Number.isSafeInteger(current))return true;
  if(lastUpdateId===null||lastUpdateId===undefined)return false;
  const previous=Number(lastUpdateId);
  return !Number.isSafeInteger(previous)||current<=previous;
}

export function paymentQuantityKeyboard(campaignId,maxCount,unitPrice,page=0,minCount=1){
  const pages=Math.max(1,Math.ceil((maxCount-minCount+1)/QUANTITY_PAGE_SIZE));
  const current=Math.max(0,Math.min(pages-1,Number(page)||0));
  const first=minCount+current*QUANTITY_PAGE_SIZE,last=Math.min(maxCount,first+QUANTITY_PAGE_SIZE-1);
  const rows=[];
  for(let n=first;n<=last;n+=2){
    const row=[Markup.button.callback(n+' کد | '+money(unitPrice*n)+' ریال','payment:quantity:'+campaignId+':'+n)];
    if(n+1<=last)row.push(Markup.button.callback((n+1)+' کد | '+money(unitPrice*(n+1))+' ریال','payment:quantity:'+campaignId+':'+(n+1)));
    rows.push(row);
  }
  if(pages>1){
    const nav=[];
    if(current>0)nav.push(Markup.button.callback('⬅️ قبلی','payment:quantity-page:'+campaignId+':'+(current-1)));
    nav.push(Markup.button.callback((current+1)+' از '+pages,'payment:quantity-page:'+campaignId+':'+current));
    if(current<pages-1)nav.push(Markup.button.callback('بعدی ➡️','payment:quantity-page:'+campaignId+':'+(current+1)));
    rows.push(nav);
  }
  rows.push([Markup.button.callback('بازگشت به کمپین','campaign:view:'+campaignId)]);
  return Markup.inlineKeyboard(rows);
}
async function showPaymentQuantityPrompt(ctx,campaignId,page=0,minCount=1){
  const [[campaign]]=await pool.execute("SELECT id,title,status,participation_type,entry_price,codes_per_entry FROM campaigns WHERE id=?",[campaignId]);
  if(!campaign||campaign.status!=='open'||campaign.participation_type!=='paid')return ctx.reply('این کمپین برای سفارش پولی در دسترس نیست.');
  const max=Number(campaign.codes_per_entry);const allowance=await getUserCampaignCodeAllowance({telegramUserId:ctx.from.id,campaignId});const remaining=Math.min(max,allowance.remaining);
  if(!Number.isInteger(max)||max<1||max>100)return ctx.reply('تنظیم تعداد کد کمپین نامعتبر است؛ با مدیریت تماس بگیرید.');
  if(remaining<minCount)return ctx.reply('با توجه به کدهای صادرشده و سفارش‌های فعال، تعداد کد قابل سفارش شما کافی نیست.');
  const marker='\n\n🧮 انتخاب تعداد کد';
  const message=ctx.callbackQuery?.message;
  const existing=message?.caption??message?.text??'';
  const rawBase=existing.includes(marker)?existing.split(marker)[0]:existing;
  const prompt=marker+'\nقیمت هر کد: '+money(campaign.entry_price)+' ریال | باقی‌مانده قابل سفارش: '+remaining+' کد\nتعداد و مبلغ کل را انتخاب کنید:';
  const limit=message?.caption!==undefined?1024:4096;
  const safePrompt=prompt.length>limit?prompt.slice(0,limit):prompt;
  const available=Math.max(0,limit-safePrompt.length);
  const base=rawBase.length>available
    ? (available>1?rawBase.slice(0,available-1)+'…':'')
    : rawBase;
  const keyboard=paymentQuantityKeyboard(campaign.id,remaining,Number(campaign.entry_price),page,minCount);
  if(message?.caption!==undefined)return ctx.editMessageCaption(base+safePrompt,{reply_markup:keyboard.reply_markup});
  if(message?.text!==undefined)return ctx.editMessageText(base+safePrompt,{reply_markup:keyboard.reply_markup});
  return ctx.reply('کمپین: '+campaign.title+safePrompt,{reply_markup:keyboard.reply_markup});
}
async function sendPaymentOrder(ctx,campaignId,requestedCodeCount){
  try{
    const r=await createOrGetOrder({telegramUserId:ctx.from.id,campaignId,requestedCodeCount});
    if(r.paid)return ctx.reply('پرداخت قبلاً تأیید شده است؛ کدهای خود را در بخش کدهای من ببینید.');
    const o=r.order;
    await pool.execute("INSERT INTO telegram_user_sessions(telegram_user_id,step,payload,last_update_id) VALUES(?,'awaiting_payment_receipt',?,?) ON DUPLICATE KEY UPDATE step=IF(VALUES(last_update_id)>COALESCE(last_update_id,-1),VALUES(step),step),payload=IF(VALUES(last_update_id)>COALESCE(last_update_id,-1),VALUES(payload),payload),last_update_id=GREATEST(COALESCE(last_update_id,-1),VALUES(last_update_id))",[String(ctx.from.id),JSON.stringify({orderId:o.id}),Number(ctx.update.update_id)]);
    const sent=await ctx.reply('سفارش #'+o.id+' | '+r.campaignTitle+'\nتعداد کد: '+Number(o.requested_code_count||requestedCodeCount)+'\nقیمت هر کد: '+money(Number(o.amount)/Number(o.requested_code_count||requestedCodeCount))+' ریال\nمبلغ دقیق: '+money(o.amount)+' ریال\nشناسه پرداخت: '+o.payment_reference+'\nبانک: '+(o.bank_name||'—')+'\nشماره کارت: '+o.card_number+'\nبه نام: '+o.card_holder+'\n'+(o.payment_instructions||'')+'\n\nپس از واریز مبلغ دقیق، تصویر رسید را به‌صورت عکس ارسال کنید. مهلت ۲۴ ساعت است. ارسال رسید به‌معنی تأیید پرداخت نیست.',Markup.inlineKeyboard([[Markup.button.callback('لغو ارسال رسید','payment:cancel:'+o.id)]]));
    await recordPaymentCardDelivery({telegramUserId:ctx.from.id,orderId:o.id}).catch(error=>logger.error({err:error,orderId:o.id},'Failed to record bank-card delivery history'));
    return sent;
  }catch(e){return ctx.reply(e.message||'ایجاد سفارش ناموفق بود.');}
}
export function userOrdersKeyboard(rows,page=0,total=rows.length,pageSize=8){
  const pages=Math.max(1,Math.ceil(total/pageSize)),current=Math.max(0,Math.min(pages-1,Number(page)||0)),visible=rows;
  const status={awaiting_receipt:'⏳ منتظر رسید',under_review:'🔎 در حال بررسی',approved:'✅ تأییدشده',rejected:'❌ ردشده',cancelled:'🚫 لغوشده',expired:'⌛ منقضی'};
  const buttons=visible.map(o=>[Markup.button.callback((status[o.status]||o.status)+' | #'+o.id+' | '+String(o.campaign_title).slice(0,22)+' | '+Number(o.requested_code_count||1)+' کد','payment:order:'+o.id)]);
  const nav=[];if(current>0)nav.push(Markup.button.callback('⬅️ قبلی','user:orders:page:'+(current-1)));if(current+1<pages)nav.push(Markup.button.callback('بعدی ➡️','user:orders:page:'+(current+1)));if(nav.length)buttons.push(nav);
  buttons.push([Markup.button.callback('🏠 منوی اصلی','user:home')]);
  return {current,pages,visible,keyboard:Markup.inlineKeyboard(buttons)};
}
export function userOrderDetailKeyboard(order){
  const buttons=[];if(['awaiting_receipt','rejected'].includes(order.status))buttons.push([Markup.button.callback(order.status==='rejected'?'🔄 ارسال مجدد رسید':'📤 ادامه پرداخت','payment:resume:'+order.id)]);
  if(order.status==='approved')buttons.push([Markup.button.callback('🎟 مشاهده کدهای من','user:codes')]);
  buttons.push([Markup.button.callback('🔙 سفارش‌های من','user:orders')],[Markup.button.callback('🏠 منوی اصلی','user:home')]);
  return Markup.inlineKeyboard(buttons);
}
async function showUserOrders(ctx,page=0){
  const pageSize=8,total=await countUserOrders(ctx.from.id),pages=Math.max(1,Math.ceil(total/pageSize)),current=Math.max(0,Math.min(pages-1,Number(page)||0)),rows=await listUserOrders(ctx.from.id,pageSize,current*pageSize);
  if(!total)return ctx.reply('هنوز سفارشی ندارید.',Markup.inlineKeyboard([[Markup.button.callback('🎁 مشاهده کمپین‌ها','user:campaigns')],[Markup.button.callback('🏠 منوی اصلی','user:home')]]));
  const {keyboard}=userOrdersKeyboard(rows,current,total,pageSize);
  return screenReply(ctx,'🧾 سفارش‌های شما\nتعداد: '+total+' | صفحه '+(current+1)+' از '+pages+'\nبرای مشاهده جزئیات، یک سفارش را انتخاب کنید.',keyboard);
}
async function showUserOrderDetail(ctx,id){
  const [[o]]=await pool.execute('SELECT o.id,o.payment_reference,o.amount,o.requested_code_count,o.currency,o.status,o.created_at,o.expires_at,o.rejection_reason,c.title campaign_title,o.card_number,o.card_holder,o.payment_instructions FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id JOIN participants p ON p.id=e.participant_id WHERE o.id=? AND p.telegram_user_id=?',[id,String(ctx.from.id)]);
  if(!o)return screenReply(ctx,'سفارش پیدا نشد یا متعلق به شما نیست.',Markup.inlineKeyboard([[Markup.button.callback('📦 سفارش‌های من','user:orders')],[Markup.button.callback('🏠 منوی اصلی','user:home')]]));
  const labels={awaiting_receipt:'⏳ در انتظار ارسال رسید',under_review:'🔎 در انتظار بررسی مدیریت',approved:'✅ پرداخت تأیید شده',rejected:'❌ رسید رد شده',cancelled:'🚫 لغو شده',expired:'⌛ منقضی شده'};
  const text='🧾 جزئیات سفارش #'+o.id+'\nکمپین: '+o.campaign_title+'\nشناسه پرداخت: '+o.payment_reference+'\nتعداد کد: '+Number(o.requested_code_count||1)+'\nمبلغ: '+money(o.amount)+' ریال\nوضعیت: '+(labels[o.status]||o.status)+'\nثبت: '+formatTehranDateTime(o.created_at)+'\nانقضا: '+formatTehranDateTime(o.expires_at)+(o.rejection_reason?'\n\nدلیل رد: '+o.rejection_reason:'');
  return screenReply(ctx,text,userOrderDetailKeyboard(o));
}

export function registerPaymentHandlers(bot){
 bot.action(/^payment:start:(\d+)$/,async ctx=>{
  const campaignId=Number(ctx.match[1]);
  const [[campaign]]=await pool.execute("SELECT codes_per_entry,status,participation_type FROM campaigns WHERE id=?",[campaignId]);
  if(!campaign||campaign.status!=='open'||campaign.participation_type!=='paid'){
    return ctx.answerCbQuery('کمپین برای سفارش پولی در دسترس نیست.',{show_alert:true});
  }
  const allowance=await getUserCampaignCodeAllowance({telegramUserId:ctx.from.id,campaignId});
  if(allowance.remaining<1){
    return ctx.answerCbQuery('سقف کدهای مجاز شما تکمیل شده یا سفارش فعالی دارید.',{show_alert:true});
  }
  await ctx.answerCbQuery();
  return showPaymentQuantityPrompt(ctx,campaignId,0,1);
 });
 bot.action(/^payment:more:(\d+)$/,async ctx=>{
  await ctx.answerCbQuery();
  return showPaymentQuantityPrompt(ctx,Number(ctx.match[1]),0,1);
 });
 bot.action(/^payment:quantity-page:(\d+):(\d+)$/,async ctx=>{await ctx.answerCbQuery();return showPaymentQuantityPrompt(ctx,Number(ctx.match[1]),Number(ctx.match[2]));});
 bot.action(/^payment:quantity:(\d+):(\d+)$/,async ctx=>{await ctx.answerCbQuery();return sendPaymentOrder(ctx,Number(ctx.match[1]),Number(ctx.match[2]));});
 bot.action(/^payment:cancel:(\d+)$/,async ctx=>{const orderId=String(ctx.match[1]);const [deleted]=await pool.execute("DELETE FROM telegram_user_sessions WHERE telegram_user_id=? AND step='awaiting_payment_receipt' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.orderId'))=?",[String(ctx.from.id),orderId]);await ctx.answerCbQuery(deleted.affectedRows?'لغو شد.':'این نشست دیگر فعال نیست.');return ctx.reply(deleted.affectedRows?'ارسال رسید سفارش #'+orderId+' لغو شد؛ خود سفارش تا پایان مهلت باقی می‌ماند.':'این دکمه مربوط به نشست قبلی است و تغییری در سفارش فعال ایجاد نکرد.',Markup.inlineKeyboard([[Markup.button.callback('📦 سفارش‌های من','user:orders')],[Markup.button.callback('🏠 منوی اصلی','user:home')]]));});
 bot.action('payment:cancel',async ctx=>{await ctx.answerCbQuery('این دکمه قدیمی است؛ سفارش‌های من را باز کنید.',{show_alert:true});return showUserOrders(ctx,0);});
 bot.action(/^payment:resume:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const o=await getUserOrder(Number(ctx.match[1]),ctx.from.id);if(!o||!['rejected','awaiting_receipt'].includes(o.status))return ctx.reply('این سفارش امکان ادامه پرداخت ندارد.',Markup.inlineKeyboard([[Markup.button.callback('📦 سفارش‌های من','user:orders')],[Markup.button.callback('🏠 منوی اصلی','user:home')]]));if(Number(o.is_expired)===1)return ctx.reply('مهلت ارسال مجدد تمام شده است؛ با پشتیبانی تماس بگیرید.',Markup.inlineKeyboard([[Markup.button.callback('📦 سفارش‌های من','user:orders')],[Markup.button.callback('💬 پشتیبانی','user:support')]]));await pool.execute("INSERT INTO telegram_user_sessions(telegram_user_id,step,payload,last_update_id) VALUES(?,'awaiting_payment_receipt',?,?) ON DUPLICATE KEY UPDATE step=IF(VALUES(last_update_id)>COALESCE(last_update_id,-1),VALUES(step),step),payload=IF(VALUES(last_update_id)>COALESCE(last_update_id,-1),VALUES(payload),payload),last_update_id=GREATEST(COALESCE(last_update_id,-1),VALUES(last_update_id))",[String(ctx.from.id),JSON.stringify({orderId:o.id}),Number(ctx.update.update_id)]);const sent=await ctx.reply('سفارش #'+o.id+'\nتعداد کد: '+Number(o.requested_code_count||1)+'\nمبلغ: '+money(o.amount)+' ریال\nکارت: '+o.card_number+'\nبه نام: '+o.card_holder+'\nتصویر رسید جدید را ارسال کنید.',Markup.inlineKeyboard([[Markup.button.callback('📦 سفارش‌های من','user:orders')],[Markup.button.callback('🏠 منوی اصلی','user:home')]]));await recordPaymentCardDelivery({telegramUserId:ctx.from.id,orderId:o.id}).catch(error=>logger.error({err:error,orderId:o.id},'Failed to record bank-card delivery history'));return sent;});
 bot.on('photo',async(ctx,next)=>{const [[session]]=await pool.execute("SELECT payload,last_update_id FROM telegram_user_sessions WHERE telegram_user_id=? AND step='awaiting_payment_receipt'",[String(ctx.from.id)]);if(!session)return next();const updateId=Number(ctx.update?.update_id);if(isStalePaymentReceiptUpdate(updateId,session.last_update_id))return ctx.reply('این تصویر مربوط به مرحله قبلی پرداخت است یا قبلاً پردازش شده؛ اگر هنوز رسیدی ثبت نکرده‌اید، عکس را دوباره ارسال کنید.');const [claimed]=await pool.execute("UPDATE telegram_user_sessions SET last_update_id=? WHERE telegram_user_id=? AND step='awaiting_payment_receipt' AND (last_update_id IS NULL OR last_update_id<?)",[updateId,String(ctx.from.id),updateId]);if(!claimed.affectedRows)return ctx.reply('نشست پرداخت هم‌زمان تغییر کرده یا این عکس قبلاً پردازش شده است؛ عکس رسید را دوباره ارسال کنید.');const p=typeof session.payload==='string'?JSON.parse(session.payload):session.payload;const photo=ctx.message.photo.at(-1);try{await submitReceipt({telegramUserId:ctx.from.id,orderId:p.orderId,fileId:photo.file_id,fileUniqueId:photo.file_unique_id,note:ctx.message.caption||'',adminIds:config.adminIds});await pool.execute("DELETE FROM telegram_user_sessions WHERE telegram_user_id=? AND step='awaiting_payment_receipt' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.orderId'))=?",[String(ctx.from.id),String(p.orderId)]);return ctx.reply('🧾 رسید ثبت شد و در صف بررسی مدیریت قرار گرفت.\nاعلان مدیریت نیز در صف ارسال قرار گرفته است. تا تأیید پرداخت، کدی صادر نمی‌شود.',Markup.inlineKeyboard([[Markup.button.callback('📦 سفارش‌های من','user:orders')],[Markup.button.callback('🏠 منوی اصلی','user:home')]]));}catch(e){return ctx.reply(e.message||'ثبت رسید ناموفق بود؛ در صورت نیاز عکس رسید را دوباره ارسال کنید.');}});
 bot.action('user:orders',async ctx=>{await ctx.answerCbQuery();return showUserOrders(ctx,0);});
 bot.action(/^user:orders:page:(\d+)$/,async ctx=>{await ctx.answerCbQuery();return showUserOrders(ctx,Number(ctx.match[1]));});
 bot.action(/^payment:order:(\d+)$/,async ctx=>{await ctx.answerCbQuery();return showUserOrderDetail(ctx,Number(ctx.match[1]));});
 bot.command('payment_settings',async ctx=>{if(!await can(ctx,'payment.settings'))return ctx.reply('دسترسی غیرمجاز.');const current=await getPaymentSettings();await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'payment_settings',JSON_OBJECT()) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)",[String(ctx.from.id)]);return ctx.reply('اطلاعات کارت را در ۴ خط ارسال کنید:\nنام بانک\nشماره کارت ۱۶ رقمی\nنام صاحب کارت\nتوضیحات یا -\n'+(current?'\nاطلاعات فعلی ثبت است؛ سفارش‌های قبلی کارت قبلی را حفظ می‌کنند.':''));});
 bot.command('payments',async ctx=>{if(!await can(ctx,'payment.read'))return ctx.reply('دسترسی غیرمجاز.');const rows=await listPendingReceipts();if(!rows.length)return ctx.reply('رسید در انتظار بررسی وجود ندارد.');for(const r of rows){const caption='رسید #'+r.receipt_id+' | سفارش #'+r.order_id+'\nشناسه پرداخت: '+r.payment_reference+'\nکمپین: '+r.campaign_title+'\nتعداد کد: '+Number(r.requested_code_count||1)+'\nمبلغ: '+money(r.amount)+' ریال\nکاربر: '+r.full_name+'\nموبایل: '+r.phone+'\nاینستاگرام: @'+r.instagram_handle+'\nیادداشت: '+(r.note||'—');await ctx.telegram.sendPhoto(ctx.chat.id,r.telegram_file_id,{caption,reply_markup:Markup.inlineKeyboard([[Markup.button.callback('تأیید پرداخت','payment:approve:'+r.receipt_id)],[Markup.button.callback('رد رسید','payment:reject:'+r.receipt_id)]]).reply_markup});}});
 bot.action(paymentApproveAction,async ctx=>{if(!await can(ctx,'payment.review'))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});try{const r=await reviewReceipt({adminId:ctx.from.id,receiptId:Number(ctx.match[1]),decision:'approve'});await ctx.answerCbQuery('تأیید شد.');await ctx.reply('✅ پرداخت سفارش #'+r.orderId+' تأیید شد؛ اعلان کدها در صف ارسال قرار گرفت.',Markup.inlineKeyboard([[Markup.button.callback('🧾 مشاهده سفارش','admin:payment:order:'+r.orderId)],[Markup.button.callback('📥 صف پرداخت','admin:payments')],[Markup.button.callback('🏠 مدیریت','admin:home')]]));}catch(e){return ctx.answerCbQuery(e.message||'تأیید ناموفق بود.',{show_alert:true});}});
 bot.action(paymentRejectAction,async ctx=>{if(!await can(ctx,'payment.review'))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'payment_reject',?) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)",[String(ctx.from.id),JSON.stringify({receiptId:Number(ctx.match[1])})]);await ctx.answerCbQuery();return ctx.reply('دلیل رد رسید را ارسال کنید؛ این متن برای کاربر نمایش داده می‌شود.');});
 bot.on('text',async(ctx,next)=>{const [rows]=await pool.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=?',[String(ctx.from.id)]);if(!rows.length)return next();const required=rows[0].step==='payment_settings'?'payment.settings':'payment.review';if(!await can(ctx,required))return next();if(!rows.length||!['payment_settings','payment_reject'].includes(rows[0].step))return next();const p=typeof rows[0].payload==='string'?JSON.parse(rows[0].payload):rows[0].payload;try{if(rows[0].step==='payment_settings'){const a=ctx.message.text.split('\n');if(a.length<3)throw Error('سه خط اول الزامی است.');await updatePaymentSettings({bankName:a[0],cardNumber:a[1],cardHolder:a[2],instructions:a[3]==='-'?'':(a[3]||''),adminId:ctx.from.id});}else await reviewReceipt({adminId:ctx.from.id,receiptId:p.receiptId,decision:'reject',reason:ctx.message.text});await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[String(ctx.from.id)]);if(rows[0].step==='payment_reject'){const [[order]]=await pool.execute('SELECT order_id FROM payment_receipts WHERE id=?',[p.receiptId]);return ctx.reply('❌ رسید رد شد و دلیل برای کاربر ارسال شد.',Markup.inlineKeyboard([[Markup.button.callback('🧾 مشاهده سفارش','admin:payment:order:'+order.order_id)],[Markup.button.callback('📥 صف پرداخت','admin:payments')],[Markup.button.callback('🏠 مدیریت','admin:home')]]));}return ctx.reply('عملیات با موفقیت ثبت شد.',Markup.inlineKeyboard([[Markup.button.callback('💳 مدیریت پرداخت','admin:payments')],[Markup.button.callback('🏠 مدیریت','admin:home')]]));}catch(e){return ctx.reply(e.message||'عملیات ناموفق بود.');}});
}
