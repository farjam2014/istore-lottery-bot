export async function deliverTelegramNotification(telegram,chatId,payload){
  const options=payload.options||{};
  if(typeof payload.photo==='string'&&payload.photo.trim()){
    const caption=String(payload.caption||'').trim();
    if(!caption)throw new Error('Photo notification caption is required.');
    if(caption.length>1024)throw new Error('Telegram photo caption must not exceed 1024 characters.');
    return telegram.sendPhoto(String(chatId),payload.photo,{...options,caption});
  }
  const text=String(payload.text||'').trim();
  if(!text)throw new Error('Text notification is required.');
  return telegram.sendMessage(String(chatId),text,options);
}
