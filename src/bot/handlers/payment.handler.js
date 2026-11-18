import {Markup} from 'telegraf';
import {config} from '../../config/env.js';
import {logger} from '../../shared/logger.js';
import {hasPermission} from '../../modules/admin/admin-role.service.js';
import {pool} from '../../database/pool.js';
import {paymentApproveAction,paymentRejectAction} from '../../modules/payments/payment-callbacks.js';
import {createOrGetOrder,getUserCampaignCodeAllowance,submitReceipt,listUserOrders,getUserOrder,listPendingReceipts,reviewReceipt,getPaymentSettings,updatePaymentSettings,recordPaymentCardDelivery} from '../../modules/payments/payment.service.js';
import {formatTehranDateTime} from '../../shared/datetime.js';
const can=async(ctx,permission)=>hasPermission(ctx.from?.id,permission);
const money=n=>Number(n||0).toLocaleString('fa-IR');
const QUANTITY_PAGE_SIZE=10;
function paymentQuantityKeyboard(campaignId,maxCount,unitPrice,page=0,minCount=2){
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
async function showPaymentQuantityPrompt(ctx,campaignId,page=0,minCount=2){
  const [[campaign]]=await pool.execute("SELECT id,title,status,participation_type,entry_price,codes_per_entry FROM campaigns WHERE id=?",[campaignId]);
  if(!campaign||campaign.status!=='open'||campaign.participation_type!=='paid')return ctx.reply('این کمپین برای سفارش پولی در دسترس نیست.');
  const max=Number(campaign.codes_per_entry);const allowance=await getUserCampaignCodeAllowance({telegramUserId:ctx.from.id,campaignId});const remaining=Math.min(max,allowance.remaining);
  if(!Number.isInteger(max)||max<1||max>100)return ctx.reply('تنظیم تعداد کد کمپین نامعتبر است؛ با مدیریت تماس بگیرید.');
  if(remaining<minCount)return ctx.reply('با توجه به کدهای صادرشده و سفارش‌های فعال، تعداد کد قابل سفارش شما کافی نیست.');
  return ctx.reply('کمپین: '+campaign.title+'\nقیمت هر کد: '+money(campaign.entry_price)+' ریال\nحداکثر تعداد مجاز: '+max+' کد\nکدهای صادرشده/رزروشده: '+(allowance.issued+allowance.reserved)+'\n\nتعداد کد موردنظر را انتخاب کنید؛ مبلغ بر اساس تعداد انتخابی محاسبه می‌شود:',paymentQuantityKeyboard(campaign.id,remaining,Number(campaign.entry_price),page,minCount));
}
async function sendPaymentOrder(ctx,campaignId,requestedCodeCount){
  try{
    const r=await createOrGetOrder({telegramUserId:ctx.from.id,campaignId,requestedCodeCount});
    if(r.paid)return ctx.reply('پرداخت قبلاً تأیید شده است؛ کدهای خود را در بخش کدهای من ببینید.');
    const o=r.order;
    await pool.execute("INSERT INTO telegram_user_sessions(telegram_user_id,step,payload) VALUES(?,'awaiting_payment_receipt',?) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)",[String(ctx.from.id),JSON.stringify({orderId:o.id})]);
    const sent=await ctx.reply('سفارش #'+o.id+' | '+r.campaignTitle+'\nتعداد کد: '+Number(o.requested_code_count||requestedCodeCount)+'\nقیمت هر کد: '+money(Number(o.amount)/Number(o.requested_code_count||requestedCodeCount))+' ریال\nمبلغ دقیق: '+money(o.amount)+' ریال\nشناسه پرداخت: '+o.payment_reference+'\nبانک: '+(o.bank_name||'—')+'\nشماره کارت: '+o.card_number+'\nبه نام: '+o.card_holder+'\n'+(o.payment_instructions||'')+'\n\nپس از واریز مبلغ دقیق، تصویر رسید را به‌صورت عکس ارسال کنید. مهلت ۲۴ ساعت است. ارسال رسید به‌معنی تأیید پرداخت نیست.',Markup.inlineKeyboard([[Markup.button.callback('لغو ارسال رسید','payment:cancel')]]));
    await recordPaymentCardDelivery({telegramUserId:ctx.from.id,orderId:o.id}).catch(error=>logger.error({err:error,orderId:o.id},'Failed to record bank-card delivery history'));
    return sent;
  }catch(e){return ctx.reply(e.message||'ایجاد سفارش ناموفق بود.');}
}
export function registerPaymentHandlers(bot){
 bot.action(/^payment:start:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const campaignId=Number(ctx.match[1]);const [[campaign]]=await pool.execute("SELECT codes_per_entry FROM campaigns WHERE id=?",[campaignId]);if(!campaign)return ctx.reply('کمپین پیدا نشد.');const allowance=await getUserCampaignCodeAllowance({telegramUserId:ctx.from.id,campaignId});if(allowance.remaining<1)return ctx.reply('سقف کدهای مجاز شما تکمیل شده یا سفارش فعالی دارید.');if(Number(campaign.codes_per_entry)===1||allowance.remaining===1)return sendPaymentOrder(ctx,campaignId,1);return ctx.reply('چند کد می‌خواهید؟',Markup.inlineKeyboard([[Markup.button.callback('۱ کد','payment:quantity:'+campaignId+':1),Markup.button.callback('کدهای بیشتر','payment:more:'+campaignId)],[Markup.button.callback('بازگشت به کمپین','campaign:view:'+campaignId)]]));});
 bot.action(/^payment:more:(\d+)$/,async ctx=>{await ctx.answerCbQuery();return showPaymentQuantityPrompt(ctx,Number(ctx.match[1]),0,2);});
 bot.action(/^payment:quantity-page:(\d+):(\d+)$/,async ctx=>{await ctx.answerCbQuery();return showPaymentQuantityPrompt(ctx,Number(ctx.match[1]),Number(ctx.match[2]));});
 bot.action(/^payment:quantity:(\d+):(\d+)$/,async ctx=>{await ctx.answerCbQuery();return sendPaymentOrder(ctx,Number(ctx.match[1]),Number(ctx.match[2]));});
 bot.action('payment:cancel',async ctx=>{await pool.execute("DELETE FROM telegram_user_sessions WHERE telegram_user_id=? AND step='awaiting_payment_receipt'",[String(ctx.from.id)]);await ctx.answerCbQuery('لغو شد.');return ctx.reply('ارسال رسید لغو شد؛ سفارش تا پایان مهلت باقی می‌ماند.');});
 bot.action(/^payment:resume:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const o=await getUserOrder(Number(ctx.match[1]),ctx.from.id);if(!o||!['rejected','awaiting_receipt'].includes(o.status))return ctx.reply('این سفارش امکان ادامه پرداخت ندارد.');if(Number(o.is_expired)===1)return ctx.reply('مهلت ارسال مجدد تمام شده است؛ با پشتیبانی تماس بگیرید.');await pool.execute("INSERT INTO telegram_user_sessions(telegram_user_id,step,payload) VALUES(?,'awaiting_payment_receipt',?) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)",[String(ctx.from.id),JSON.stringify({orderId:o.id})]);const sent=await ctx.reply('سفارش #'+o.id+'\nتعداد کد: '+Number(o.requested_code_count||1)+'\nمبلغ: '+money(o.amount)+' ریال\nکارت: '+o.card_number+'\nبه نام: '+o.card_holder+'\nتصویر رسید جدید را ارسال کنید.');await recordPaymentCardDelivery({telegramUserId:ctx.from.id,orderId:o.id}).catch(error=>logger.error({err:error,orderId:o.id},'Failed to record bank-card delivery history'));return sent;});
 bot.on('photo',async(ctx,next)=>{const [rows]=await pool.execute("SELECT payload FROM telegram_user_sessions WHERE telegram_user_id=? AND step='awaiting_payment_receipt'",[String(ctx.from.id)]);if(!rows.length)return next();const p=typeof rows[0].payload==='string'?JSON.parse(rows[0].payload):rows[0].payload;const photo=ctx.message.photo.at(-1);try{await submitReceipt({telegramUserId:ctx.from.id,orderId:p.orderId,fileId:photo.file_id,fileUniqueId:photo.file_unique_id,note:ctx.message.caption||'',adminIds:config.adminIds});await pool.execute("DELETE FROM telegram_user_sessions WHERE telegram_user_id=? AND step='awaiting_payment_receipt'",[String(ctx.from.id)]);return ctx.reply('رسید ثبت شد و در صف بررسی مدیریت قرار گرفت. اعلان مدیریت نیز در صف ارسال قرار گرفت؛ تا تأیید پرداخت، کدی صادر نمی‌شود.');}catch(e){return ctx.reply(e.message||'ثبت رسید ناموفق بود.');}});
 bot.action('user:orders',async ctx=>{await ctx.answerCbQuery();const rows=await listUserOrders(ctx.from.id);if(!rows.length)return ctx.reply('هنوز سفارشی ندارید.',Markup.inlineKeyboard([[Markup.button.callback('مشاهده کمپین‌ها','user:campaigns')]]));for(const o of rows){const label={awaiting_receipt:'در انتظار رسید',under_review:'در انتظار بررسی',approved:'پرداخت تأییدشده',rejected:'رسید ردشده',cancelled:'لغوشده',expired:'منقضی‌شده'}[o.status]||o.status;const kb=['awaiting_receipt','rejected'].includes(o.status)?Markup.inlineKeyboard([[Markup.button.callback(o.status==='rejected'?'ارسال مجدد رسید':'ادامه پرداخت و ارسال رسید','payment:resume:'+o.id)]]):undefined;await ctx.reply('#'+o.id+' — '+o.campaign_title+'\nشناسه پرداخت: '+o.payment_reference+'\nتعداد کد: '+Number(o.requested_code_count||1)+'\nمبلغ: '+money(o.amount)+' ریال\nثبت سفارش: '+formatTehranDateTime(o.created_at)+'\nانقضا: '+formatTehranDateTime(o.expires_at)+'\nوضعیت: '+label+(o.rejection_reason?'\nدلیل رد: '+o.rejection_reason:''),kb);}});
 bot.command('payment_settings',async ctx=>{if(!await can(ctx,'payment.settings'))return ctx.reply('دسترسی غیرمجاز.');const current=await getPaymentSettings();await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'payment_settings',JSON_OBJECT()) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)",[String(ctx.from.id)]);return ctx.reply('اطلاعات کارت را در ۴ خط ارسال کنید:\nنام بانک\nشماره کارت ۱۶ رقمی\nنام صاحب کارت\nتوضیحات یا -\n'+(current?'\nاطلاعات فعلی ثبت است؛ سفارش‌های قبلی کارت قبلی را حفظ می‌کنند.':''));});
 bot.command('payments',async ctx=>{if(!await can(ctx,'payment.read'))return ctx.reply('دسترسی غیرمجاز.');const rows=await listPendingReceipts();if(!rows.length)return ctx.reply('رسید در انتظار بررسی وجود ندارد.');for(const r of rows){const caption='رسید #'+r.receipt_id+' | سفارش #'+r.order_id+'\nشناسه پرداخت: '+r.payment_reference+'\nکمپین: '+r.campaign_title+'\nتعداد کد: '+Number(r.requested_code_count||1)+'\nمبلغ: '+money(r.amount)+' ریال\nکاربر: '+r.full_name+'\nموبایل: '+r.phone+'\nاینستاگرام: @'+r.instagram_handle+'\nیادداشت: '+(r.note||'—');await ctx.telegram.sendPhoto(ctx.chat.id,r.telegram_file_id,{caption,reply_markup:Markup.inlineKeyboard([[Markup.button.callback('تأیید پرداخت','payment:approve:'+r.receipt_id)],[Markup.button.callback('رد رسید','payment:reject:'+r.receipt_id)]]).reply_markup});}});
 bot.action(paymentApproveAction,async ctx=>{if(!await can(ctx,'payment.review'))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});try{const r=await reviewReceipt({adminId:ctx.from.id,receiptId:Number(ctx.match[1]),decision:'approve'});await ctx.answerCbQuery('تأیید شد.');await ctx.reply('پرداخت سفارش #'+r.orderId+' تأیید شد؛ اعلان کدها در صف ارسال قرار گرفت.');}catch(e){return ctx.answerCbQuery(e.message||'تأیید ناموفق بود.',{show_alert:true});}});
 bot.action(paymentRejectAction,async ctx=>{if(!await can(ctx,'payment.review'))return ctx.answerCbQuery('دسترسی غیرمجاز.',{show_alert:true});await pool.execute("INSERT INTO admin_wizards(telegram_user_id,step,payload) VALUES(?,'payment_reject',?) ON DUPLICATE KEY UPDATE step=VALUES(step),payload=VALUES(payload)",[String(ctx.from.id),JSON.stringify({receiptId:Number(ctx.match[1])})]);await ctx.answerCbQuery();return ctx.reply('دلیل رد رسید را ارسال کنید؛ این متن برای کاربر نمایش داده می‌شود.');});
 bot.on('text',async(ctx,next)=>{const [rows]=await pool.execute('SELECT step,payload FROM admin_wizards WHERE telegram_user_id=?',[String(ctx.from.id)]);if(!rows.length)return next();const required=rows[0].step==='payment_settings'?'payment.settings':'payment.review';if(!await can(ctx,required))return next();if(!rows.length||!['payment_settings','payment_reject'].includes(rows[0].step))return next();const p=typeof rows[0].payload==='string'?JSON.parse(rows[0].payload):rows[0].payload;try{if(rows[0].step==='payment_settings'){const a=ctx.message.text.split('\n');if(a.length<3)throw Error('سه خط اول الزامی است.');await updatePaymentSettings({bankName:a[0],cardNumber:a[1],cardHolder:a[2],instructions:a[3]==='-'?'':(a[3]||''),adminId:ctx.from.id});}else await reviewReceipt({adminId:ctx.from.id,receiptId:p.receiptId,decision:'reject',reason:ctx.message.text});await pool.execute('DELETE FROM admin_wizards WHERE telegram_user_id=?',[String(ctx.from.id)]);return ctx.reply('عملیات با موفقیت ثبت شد.');}catch(e){return ctx.reply(e.message||'عملیات ناموفق بود.');}});
}
