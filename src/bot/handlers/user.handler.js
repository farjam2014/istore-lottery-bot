import {Markup} from 'telegraf';
import {listOpenCampaigns,getCampaignById,listParticipantCodes} from '../../modules/campaigns/campaign.service.js';
import {joinFreeCampaign} from '../../modules/entries/entry.service.js';
import {userMenuKeyboard} from '../keyboards/user.keyboard.js';

export function registerUserHandlers(bot){
  bot.action('user:campaigns',async ctx=>{await ctx.answerCbQuery();return showCampaignPage(ctx,0);});
  bot.action(/^user:campaigns:page:(\d+)$/,async ctx=>{await ctx.answerCbQuery();return showCampaignPage(ctx,Number(ctx.match[1]));});
  bot.action(/^campaign:view:(\d+)$/,async ctx=>{
    await ctx.answerCbQuery();
    const campaign=await getCampaignById(Number(ctx.match[1]));
    if(!campaign||campaign.status!=='open')return ctx.reply('این کمپین دیگر در دسترس نیست.');
    const lines=[\`🎁 \${campaign.title}\`,campaign.description||'توضیحی ثبت نشده است.',campaign.prize_title?\`جایزه: \${campaign.prize_title}\`:null,campaign.prize_description||null,campaign.prize_value?\`ارزش تقریبی جایزه: \${Number(campaign.prize_value).toLocaleString('fa-IR')} ریال\`:null,\`نوع شرکت: \${campaign.participation_type==='free'?'رایگان':'پولی'}\`,campaign.participation_type==='paid'?\`هزینه شرکت: \${Number(campaign.entry_price||0).toLocaleString('fa-IR')} ریال\`:'شرکت رایگان',campaign.starts_at?\`شروع: \${campaign.starts_at}\`:null,campaign.ends_at?\`پایان: \${campaign.ends_at}\`:null,campaign.draw_at?\`زمان قرعه‌کشی: \${campaign.draw_at}\`:null,campaign.capacity?\`ظرفیت کل: \${campaign.capacity} | ثبت‌نام/رزرو: \${Number(campaign.participant_count||0)}\`:'ظرفیت: نامحدود',campaign.terms?\`قوانین و شرایط:\\n\${campaign.terms}\`:null].filter(Boolean);
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
  bot.action('user:support',async ctx=>{await ctx.answerCbQuery();return ctx.reply('پیام خود را برای پشتیبانی ارسال کنید.',userMenuKeyboard());});
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
