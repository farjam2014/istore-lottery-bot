export async function privateChatOnly(ctx,next){if(ctx.chat?.type!=='private'){if(ctx.chat?.id)await ctx.reply('این ربات فقط در گفت‌وگوی خصوصی قابل استفاده است.');return;}return next();}
