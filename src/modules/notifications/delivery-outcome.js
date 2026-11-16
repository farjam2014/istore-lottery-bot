export function classifyTelegramDeliveryError(error){
  const response=error?.response;
  const code=Number(response?.error_code??response?.status??error?.statusCode??error?.status);
  if(!Number.isInteger(code)||code<100)return {kind:'uncertain',reason:'no-definitive-telegram-response'};
  if(code===429){
    const retryAfter=Number(response?.parameters?.retry_after);
    return {
      kind:'retry',
      retryAfterSeconds:Number.isSafeInteger(retryAfter)&&retryAfter>0?Math.min(3600,retryAfter):null
    };
  }
  if(code===408||code>=500)return {kind:'uncertain',reason:'ambiguous-server-response',errorCode:code};
  if(code>=400&&code<500)return {kind:'permanent',errorCode:code};
  return {kind:'uncertain',reason:'unexpected-response',errorCode:code};
}
