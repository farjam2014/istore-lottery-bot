import {Markup} from 'telegraf';
import {completeRegistration,getSession,saveSession,advanceSession,clearSession,findProfile,updatePrivacyConsent,normalizeFullName,normalizePhone} from '../../modules/participants/participant.service.js';
import {promptFor} from './start.handler.js';
import {userMenuKeyboard,cancelKeyboard,registrationKeyboard,registrationStartKeyboard,phoneShareKeyboard,privacyNoticeKeyboard} from '../keyboards/user.keyboard.js';
import {config} from '../../config/env.js';

export function registerRegistrationHandlers(bot){
  bot.action('registration:start',async ctx=>{
    const profile=await findProfile(ctx.from.id);
    if(profile){await ctx.answerCbQuery('حساب شما قبلاً ثبت شده است.');return ctx.reply('حساب شما قبلاً ثبت شده است.',userMenuKeyboard());}
    const s=await getSession(ctx.from.id);
    if(!s||s.payload?.privacyConsentVersion!==config.PRIVACY_NOTICE_VERSION){
      await ctx.answerCbQuery();
      return ctx.reply('پیش از جمع‌آوری اطلاعات شخصی، لطفاً اطلاعیه حریم خصوصی را مطالعه و تأیید کنید.',privacyNoticeKeyboard(config.PRIVACY_NOTICE_URL));
    }
    await ctx.answerCbQuery();
    if(s.step==='awaiting_phone'){
      return ctx.reply('برای تأیید مالکیت شماره، از دکمه «اشتراک‌گذاری شماره موبایل» استفاده کنید. شماره‌ای که دستی تایپ شود پذیرفته نیست.',phoneShareKeyboard());
    }
    return ctx.reply(promptFor(s.step),cancelKeyboard());
  });
  bot.action('privacy:accept',async ctx=>{
    const version=config.PRIVACY_NOTICE_VERSION;
    if(!version||!config.PRIVACY_NOTICE_URL)return ctx.answerCbQuery('اطلاعیه حریم خصوصی هنوز پیکربندی نشده است.',{show_alert:true});
    const profile=await findProfile(ctx.from.id);
    if(profile){
      await updatePrivacyConsent(ctx.from.id,version);
      await ctx.answerCbQuery('تأیید شما ثبت شد.');
      return ctx.reply('تأیید اطلاعیه حریم خصوصی ثبت شد. می‌توانید از ربات استفاده کنید.',userMenuKeyboard());
    }
    await saveSession(ctx.from.id,'awaiting_name',{privacyConsentVersion:version});
    await ctx.answerCbQuery('تأیید شما ثبت شد.');
    return ctx.reply(promptFor('awaiting_name'),cancelKeyboard());
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
    if(s.payload?.privacyConsentVersion!==config.PRIVACY_NOTICE_VERSION)return ctx.reply('ابتدا اطلاعیه حریم خصوصی را مطالعه و تأیید کنید.',privacyNoticeKeyboard(config.PRIVACY_NOTICE_URL));
    if(s.lastUpdateId===Number(ctx.update.update_id))return ctx.reply('شماره موبایل ثبت شد. حالا آیدی اینستاگرام را بدون @ ارسال کنید.',Markup.removeKeyboard());
    const contact=ctx.message.contact;
    if(!contact.user_id||String(contact.user_id)!==String(ctx.from.id)){
      return ctx.reply('این شماره به‌عنوان مخاطب حساب تلگرام شما تأیید نشد. لطفاً فقط دکمه اشتراک‌گذاری شماره خودتان را بزنید.',phoneShareKeyboard());
    }
    try{
      const phone=normalizePhone(contact.phone_number);
      const data={...(s.payload||{}),phone};
      await advanceSession(ctx.from.id,s.step,'awaiting_instagram',data,ctx.update.update_id);
      await ctx.reply('شماره موبایل دریافت و مالکیت آن با حساب تلگرام شما تطبیق داده شد. حالا آیدی اینستاگرام را بدون @ ارسال کنید.',Markup.removeKeyboard());
    }catch(error){
      return ctx.reply(error.message||'شماره موبایل معتبر نیست. دوباره اشتراک‌گذاری کنید.',phoneShareKeyboard());
    }
  });
  bot.on('text',async(ctx,next)=>{
    if(config.adminIds.has(String(ctx.from.id)))return next();
    const s=await getSession(ctx.from.id);
    const value=ctx.message.text.trim();
    if(!s&&value==='ثبت‌نام')return ctx.reply('پیش از ادامه، لطفاً اطلاعیه حریم خصوصی را مطالعه و تأیید کنید.',privacyNoticeKeyboard(config.PRIVACY_NOTICE_URL));
    if(!s)return next();
    if(s.payload?.privacyConsentVersion!==config.PRIVACY_NOTICE_VERSION)return ctx.reply('ابتدا اطلاعیه حریم خصوصی را مطالعه و تأیید کنید.',privacyNoticeKeyboard(config.PRIVACY_NOTICE_URL));
    if(s.lastUpdateId===Number(ctx.update.update_id)){
      if(s.step==='awaiting_phone')return ctx.reply('برای تأیید مالکیت، شماره موبایل خودتان را با دکمه زیر به اشتراک بگذارید.',phoneShareKeyboard());
      if(s.step==='awaiting_instagram')return ctx.reply('حالا آیدی اینستاگرام را بدون @ ارسال کنید.',Markup.removeKeyboard());
      return ctx.reply(promptFor(s.step),cancelKeyboard());
    }
    const data=s.payload||{};
    if(s.step==='awaiting_phone'&&value==='❌ انصراف از ثبت‌نام'){
      await clearSession(ctx.from.id);
      return ctx.reply('ثبت‌نام لغو شد. برای شروع مجدد، دکمه «ثبت‌نام» را بزنید.',registrationStartKeyboard());
    }
    try{
      if(s.step==='awaiting_name'){
        normalizeFullName(value);data.fullName=value;
        await advanceSession(ctx.from.id,s.step,'awaiting_phone',data,ctx.update.update_id);
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
