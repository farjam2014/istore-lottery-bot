import {Markup} from 'telegraf';
import {completeRegistration,getSession,saveSession,clearSession,normalizeFullName,normalizePhone} from '../../modules/participants/participant.service.js';
import {promptFor} from './start.handler.js';
import {userMenuKeyboard,cancelKeyboard,registrationKeyboard,registrationStartKeyboard,phoneShareKeyboard} from '../keyboards/user.keyboard.js';
import {config} from '../../config/env.js';

export function registerRegistrationHandlers(bot){
  bot.action('registration:start',async ctx=>{
    await ctx.answerCbQuery();
    const s=await getSession(ctx.from.id);
    if(!s)await saveSession(ctx.from.id,'awaiting_name',{});
    const step=s?.step||'awaiting_name';
    if(step==='awaiting_phone'){
      return ctx.reply('برای تأیید مالکیت شماره، از دکمه «اشتراک‌گذاری شماره موبایل» استفاده کنید. شماره‌ای که دستی تایپ شود پذیرفته نیست.',phoneShareKeyboard());
    }
    await ctx.reply(promptFor(step),cancelKeyboard());
  });
  bot.action('registration:cancel',async ctx=>{
    await clearSession(ctx.from.id);
    await ctx.answerCbQuery('ثبت‌نام متوقف شد.');
    await ctx.reply('هر زمان خواستید می‌توانید ثبت‌نام را شروع کنید.',registrationKeyboard());
  });
  bot.command('cancel',async(ctx,next)=>{
    if(config.adminIds.has(String(ctx.from.id)))return next();
    await clearSession(ctx.from.id);
    await ctx.reply('فرآیند ثبت‌نام لغو شد. برای شروع مجدد، دکمه «ثبت‌نام» را بزنید.',registrationStartKeyboard());
  });
  bot.on('contact',async(ctx,next)=>{
    if(config.adminIds.has(String(ctx.from.id)))return next();
    const s=await getSession(ctx.from.id);
    if(!s||s.step!=='awaiting_phone')return next();
    const contact=ctx.message.contact;
    if(!contact.user_id||String(contact.user_id)!==String(ctx.from.id)){
      return ctx.reply('این شماره به‌عنوان مخاطب حساب تلگرام شما تأیید نشد. لطفاً فقط دکمه اشتراک‌گذاری شماره خودتان را بزنید.',phoneShareKeyboard());
    }
    try{
      const phone=normalizePhone(contact.phone_number);
      const data={...(s.payload||{}),phone};
      await saveSession(ctx.from.id,'awaiting_instagram',data);
      await ctx.reply('شماره موبایل دریافت و مالکیت آن با حساب تلگرام شما تطبیق داده شد. حالا آیدی اینستاگرام را بدون @ ارسال کنید.',Markup.removeKeyboard());
    }catch(error){
      return ctx.reply(error.message||'شماره موبایل معتبر نیست. دوباره اشتراک‌گذاری کنید.',phoneShareKeyboard());
    }
  });
  bot.on('text',async(ctx,next)=>{
    if(config.adminIds.has(String(ctx.from.id)))return next();
    const s=await getSession(ctx.from.id);
    const value=ctx.message.text.trim();
    if(!s&&value==='ثبت‌نام'){
      await saveSession(ctx.from.id,'awaiting_name',{});
      return ctx.reply(promptFor('awaiting_name'),cancelKeyboard());
    }
    if(!s)return next();
    const data=s.payload||{};
    if(s.step==='awaiting_phone'&&value==='❌ انصراف از ثبت‌نام'){
      await clearSession(ctx.from.id);
      return ctx.reply('ثبت‌نام لغو شد. برای شروع مجدد، دکمه «ثبت‌نام» را بزنید.',registrationStartKeyboard());
    }
    try{
      if(s.step==='awaiting_name'){
        normalizeFullName(value);data.fullName=value;
        await saveSession(ctx.from.id,'awaiting_phone',data);
        return ctx.reply('برای تأیید مالکیت، شماره موبایل خودتان را با دکمه زیر به اشتراک بگذارید. واردکردن دستی شماره پذیرفته نیست.',phoneShareKeyboard());
      }
      if(s.step==='awaiting_phone'){
        return ctx.reply('شماره را تایپ نکنید؛ لطفاً دکمه «اشتراک‌گذاری شماره موبایل» را بزنید یا «انصراف از ثبت‌نام» را انتخاب کنید.',phoneShareKeyboard());
      }
      if(s.step==='awaiting_instagram'){
        data.instagramHandle=value;
        await completeRegistration(ctx,data);
        return ctx.reply('ثبت‌نام شما با موفقیت تکمیل شد. شماره موبایل تأییدشده و اطلاعات حساب ذخیره شدند.',userMenuKeyboard());
      }
    }catch(error){return ctx.reply(error.message||'خطا در ثبت اطلاعات. دوباره تلاش کنید.');}
    return next();
  });
}
