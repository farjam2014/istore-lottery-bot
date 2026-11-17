const persianDigits='۰۱۲۳۴۵۶۷۸۹';
const arabicDigits='٠١٢٣٤٥٦٧٨٩';

export function normalizeParticipantSearchDigits(value){
  return String(value??'').replace(/[۰-۹٠-٩]/g,d=>{
    const index=persianDigits.indexOf(d);
    return String(index>=0?index:arabicDigits.indexOf(d));
  });
}

function escapeLike(value){
  return String(value).replace(/!/g,'!!').replace(/%/g,'!%').replace(/_/g,'!_');
}

export function buildParticipantSearch(query){
  const normalized=normalizeParticipantSearchDigits(query).trim().slice(0,100);
  const instagram=normalized.replace(/^@/,'');
  const compactPhone=normalized.replace(/[^\d+]/g,'');
  const digits=compactPhone.replace(/\D/g,'');
  const phoneCandidates=new Set([normalized]);
  if(digits.startsWith('09')&&digits.length>=3)phoneCandidates.add('+98'+digits.slice(1));
  else if(digits.startsWith('989')&&digits.length>=3)phoneCandidates.add('+'+digits);
  else if(compactPhone.startsWith('+989')&&digits.length>=3)phoneCandidates.add('+'+digits);
  const phoneLikes=[...phoneCandidates].map(value=>'%'+escapeLike(value)+'%');
  const where='WHERE p.full_name LIKE ? ESCAPE \'!\' OR ('+
    phoneLikes.map(()=>'p.phone LIKE ? ESCAPE \'!\'').join(' OR ')+
    ') OR p.instagram_handle LIKE ? ESCAPE \'!\' OR CAST(p.telegram_user_id AS CHAR)=?';
  return {
    query:normalized,
    where,
    params:['%'+escapeLike(normalized)+'%',...phoneLikes,'%'+escapeLike(instagram)+'%',digits||normalized]
  };
}

export function paginateParticipantResults(page,total,limit=8){
  const safeLimit=Number.isSafeInteger(limit)&&limit>0?limit:8;
  const totalCount=Number.isFinite(Number(total))?Math.max(0,Math.trunc(Number(total))):0;
  const pages=Math.max(1,Math.ceil(totalCount/safeLimit));
  const requested=Number(page);
  const safePage=Number.isSafeInteger(requested)&&requested>=0?requested:0;
  const current=Math.min(safePage,pages-1);
  return {page:current,pages,offset:current*safeLimit,total:totalCount,limit:safeLimit};
}
