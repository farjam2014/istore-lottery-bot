import {Markup} from 'telegraf';
import {listOpenCampaigns,listParticipantCodes} from '../../modules/campaigns/campaign.service.js';
import {joinFreeCampaign} from '../../modules/entries/entry.service.js';
import {userMenuKeyboard} from '../keyboards/user.keyboard.js';

export function registerUserHandlers(bot){
  bot.action('user:campaigns',async ctx=>{
    await ctx.answerCbQuery();
    const rows=await listOpenCampaigns();
    if(!rows.length)return ctx.reply('در حال حاضر کمپین فعالی وجود ندارد.',userMenuKeyboard());
    for(const c of rows){
      const body=[`🎁 ${c.title}`,c.description||'',`نوع شرکت: ${c.participation_type==='free'?'رایگان':'پرداختی'}`,c.capacity?`ظرفیت: ${c.capacity}`:''].filter(Boolean).join('\n');
      await ctx.reply(body,Markup.inlineKeyboard([[Markup.button.callback('مشاهده و شرکت',`campaign:view:${c.id}`)]]));
    }
  });
  bot.action(/^campaign:view:(\d+)$/,async ctx=>{
    await ctx.answerCbQuery();
    const rows=await listOpenCampaigns();
    const campaign=rows.find(x=>x.id===Number(ctx.match[1]));
    if(!campaign)return ctx.reply('این کمپین دیگر در دسترس نیست.');
    const buttons=campaign.participation_type==='free'?[[Markup.button.callback('شرکت در کمپین',`campaign:join:${campaign.id}`)]]:[];
    return ctx.reply(`🎁 ${campaign.title}\n\n${campaign.description||'توضیحی ثبت نشده است.'}\n\nنوع شرکت: ${campaign.participation_type==='free'?'رایگان':'پرداختی'}`,buttons.length?Markup.inlineKeyboard(buttons):userMenuKeyboard());
  });
  bot.action(/^campaign:join:(\d+)$/,async ctx=>{
    await ctx.answerCbQuery();
    try{
      const result=await joinFreeCampaign({telegramUserId:ctx.from.id,campaignId:Number(ctx.match[1])});
      const heading=result.alreadyJoined?'شما قبلاً در این کمپین ثبت‌نام کرده‌اید.':'ثبت‌نام شما در کمپین با موفقیت انجام شد.';
      const codes=result.codes.length?result.codes.join('\n'):'کدی برای این ورودی ثبت نشده است.';
      return ctx.reply(`${heading}\n\nکدهای اختصاصی شما:\n${codes}`,userMenuKeyboard());
    }catch(error){return ctx.reply(error.message||'ثبت‌نام در کمپین انجام نشد.',userMenuKeyboard());}
  });
  bot.action('user:codes',async ctx=>{
    await ctx.answerCbQuery();
    const rows=await listParticipantCodes(ctx.from.id);
    if(!rows.length)return ctx.reply('هنوز کدی برای شما صادر نشده است.',userMenuKeyboard());
    return ctx.reply('کدهای شما:\n'+rows.map(x=>`${x.code} — ${x.campaign_title}`).join('\n'),userMenuKeyboard());
  });
  bot.action('user:account',async ctx=>{
    await ctx.answerCbQuery();const p=ctx.state.profile;
    return ctx.reply(`نام: ${p.full_name}\nموبایل: ${p.phone}\nاینستاگرام: @${p.instagram_handle}`,userMenuKeyboard());
  });
  bot.action('user:orders',async ctx=>{await ctx.answerCbQuery();return ctx.reply('بخش سفارش‌ها در مرحله بعد تکمیل می‌شود.',userMenuKeyboard());});
  bot.action('user:support',async ctx=>{await ctx.answerCbQuery();return ctx.reply('پیام پشتیبانی خود را ارسال کنید. اتصال به صف پشتیبانی در مرحله بعد فعال می‌شود.',userMenuKeyboard());});
}
