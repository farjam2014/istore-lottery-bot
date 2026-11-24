export async function screenReply(ctx,...args){
  const message=ctx.callbackQuery?.message;
  if(message){
    try{
      if(message.text!==undefined)return await ctx.editMessageText(...args);
      if(message.caption!==undefined)return await ctx.editMessageCaption(...args);
    }catch(error){
      if(/message is not modified/i.test(String(error?.message||'')))return;
      return ctx.reply(...args);
    }
  }
  return ctx.reply(...args);
}
