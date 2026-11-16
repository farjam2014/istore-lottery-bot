import {Markup} from 'telegraf';
import {completeRegistration,getSession,saveSession,clearSession,normalizeFullName,normalizePhone} from '../../modules/participants/participant.service.js';
import {promptFor} from './start.handler.js';
import {userMenuKeyboard,cancelKeyboard,registrationKeyboard,phoneShareKeyboard,instagramStepKeyboard} from '../keyboards/user.keyboard.js';
import {config} from '../../config/env.js';
import {hasPermission} from '../../modules/admin/admin-role.service.js';
import {shouldBypassRegistration} from '../middleware/registration-admin.js';

const bypassRegistration=ctx=>shouldBypassRegistration({
  telegramId:ctx.from?.id,
  configuredAdminIds:config.adminIds,
  hasDashboardPermission:id=>hasPermission(id,'dashboard.read')
});

export function registerRegistrationHandlers(bot){
  bot.action('registration:start',async(ctx,next)=>{
    if(await bypassRegistration(ctx))return next();
    await ctx.answerCbQuery();
    const s=await getSession(ctx.from.id);
    if(!s)await saveSession(ctx.from.id,'awaiting_name',{});
    const step=s?.step||'awaiting_name';
    if(step==='awaiting_phone'){
      await ctx.reply('برای تأیید مالکیت شماره، از دکمه «اشتراک‌گذاری شماره موبایل» استفاده کنید. شماره‌ای که دستی تایپ شود پذیرفته نیست.',phoneShareKeyboard());
      return ctx.reply('برای توقف فرایند:',cancelKeyboard());
    }
    if(step==='awaiting_instagram')return ctx.reply(promptFor(step),instagramStepKeyboard());
    await ctx.reply(promptFor(step),cancelKeyboard());
  });
  bot.action('registration:back:phone',async(ctx,next)=>{
    if(await bypassRegistration(ctx))return next();
    const s=await getSession(ctx.from.id);
    if(!s||s.step!=='awaiting_instagram')return ctx.answerCbQuery('مرحله فعالی برای بازگشت وجود ندارد.');
    await saveSession(ctx.from.id,'awaiting_phone',{fullName:s.payload?.fullName});
    await ctx.answerCbQuery('به مرحله تأیید شماره بازگشتید.');
    await ctx.reply('برای تأیید مالکیت، شماره موبایل خودتان را با دکمه زیر دوباره به اشتراک بگذارید.',phoneShareKeyboard());
    return ctx.reply('در صورت انصراف:',cancelKeyboard());
  });
  bot.action('registration:cancel',async(ctx,next)=>{
    if(await bypassRegistration(ctx))return next();
    await clearSession(ctx.from.id);
    await ctx.answerCbQuery('ثبت‌نام متوقف شد.');
    await ctx.reply('هر زمان خواستید می‌توانید ثبت‌نام را شروع کنید.',registrationKeyboard());
  });
  bot.command('cancel',async(ctx,next)=>{
    if(await bypassRegistration(ctx))return next();
    await clearSession(ctx.from.id);
    await ctx.reply('فرآیند ثبت‌نام لغو شد.',registrationKeyboard());
  });
  bot.on('contact',async(ctx,next)=>{
    if(config.adminIds.has(String(ctx.from.id)))return next();
    const s=await getSession(ctx.from.id);
    if(!s||s.step!=='awaiting_phone')return next();
    if(await bypassRegistration(ctx))return next();
    const contact=ctx.message.contact;
    if(!contact.user_id||String(contact.user_id)!==String(ctx.from.id)){
      return ctx.reply('این شماره به‌عنوان مخاطب حساب تلگرام شما تأیید نشد. لطفاً فقط دکمه اشتراک‌گذاری شماره خودتان را بزنید.',phoneShareKeyboard());
    }
    try{
      const phone=normalizePhone(contact.phone_number);
      const data={...(s.payload||{}),phone};
      await saveSession(ctx.from.id,'awaiting_instagram',data);
      await ctx.reply('شماره موبایل دریافت و مالکیت آن با حساب تلگرام شما تطبیق داده شد.',Markup.removeKeyboard());
      return ctx.reply('حالا آیدی اینستاگرام را بدون @ ارسال کنید. اگر لازم بود می‌توانید به مرحله تأیید شماره برگردید.',instagramStepKeyboard());
    }catch(error){
      return ctx.reply(error.message||'شماره موبایل معتبر نیست. دوباره اشتراک‌گذاری کنید.',phoneShareKeyboard());
    }
  });
  bot.on('text',async(ctx,next)=>{
    if(config.adminIds.has(String(ctx.from.id)))return next();
    const s=await getSession(ctx.from.id);if(!s)return next();
    if(await bypassRegistration(ctx))return next();
    const value=ctx.message.text.trim();const data=s.payload||{};
    try{
      if(s.step==='awaiting_name'){
        normalizeFullName(value);data.fullName=value;
        await saveSession(ctx.from.id,'awaiting_phone',data);
        await ctx.reply('برای تأیید مالکیت، شماره موبایل خودتان را با دکمه زیر به اشتراک بگذارید. واردکردن دستی شماره پذیرفته نیست.',phoneShareKeyboard());
        return ctx.reply('در صورت انصراف:',cancelKeyboard());
      }
      if(s.step==='awaiting_phone'){
        if(value==='⬅️ بازگشت به نام'){
          await saveSession(ctx.from.id,'awaiting_name',data);
          return ctx.reply(promptFor('awaiting_name'),cancelKeyboard());
        }
        return ctx.reply('شماره را تایپ نکنید؛ لطفاً دکمه «اشتراک‌گذاری شماره موبایل» را بزنید.',phoneShareKeyboard());
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
