export function isTelegramCommandText(value){
  return typeof value==='string' && /^\\/[a-z0-9_]+(?:@[a-z0-9_]+)?(?:\\s|$)/i.test(value.trim());
}
