const TIME_ZONE='Asia/Tehran';
const jalaliPartsFormatter=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{timeZone:'UTC',year:'numeric',month:'numeric',day:'numeric'});
const tehranFormatter=new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const displayFormatter=new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arabext',{timeZone:TIME_ZONE,calendar:'persian',numberingSystem:'arabext',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const digitMap={'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9','٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
const normalizeDigits=value=>String(value).replace(/[۰-۹٠-٩]/g,d=>digitMap[d]);
function parts(formatter,date){return Object.fromEntries(formatter.formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));}
export function parseUtcDateTime(value){
  if(value instanceof Date){if(Number.isNaN(value.getTime()))throw new Error('تاریخ نامعتبر است.');return new Date(value.getTime());}
  if(typeof value!=='string')throw new TypeError('تاریخ باید رشته یا Date باشد.');
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if(!match)throw new Error('قالب تاریخ UTC نامعتبر است.');
  const [,ys,mos,ds,hs='00',mis='00',ss='00']=match;
  const nums=[ys,mos,ds,hs,mis,ss].map(Number),[y,m,d,h,mi,s]=nums;
  const date=new Date(Date.UTC(y,m-1,d,h,mi,s));
  if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d||h>23||mi>59||s>59)throw new Error('تاریخ UTC نامعتبر است.');
  return date;
}
export function formatTehranDateTime(value){
  if(value===null||value===undefined||value==='')return '—';
  const date=parseUtcDateTime(value);
  return displayFormatter.format(date);
}
export function formatTehranDate(value){
  if(value===null||value===undefined||value==='')return '—';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arabext',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(parseUtcDateTime(value));
}
function jalaliToGregorian(year,month,day){
  if(year<1200||year>1600||month<1||month>12||day<1||day>31)throw new Error('تاریخ شمسی خارج از محدوده مجاز است.');
  const start=Date.UTC(year+621,2,15),end=Date.UTC(year+622,3,5);
  for(let t=start;t<=end;t+=86400000){
    const date=new Date(t),p=parts(jalaliPartsFormatter,date);
    if(p.year===year&&p.month===month&&p.day===day)return {year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate()};
  }
  throw new Error('روز واردشده در تقویم شمسی معتبر نیست.');
}
function tehranLocalToUtc({year,month,day,hour,minute}){
  const greg=jalaliToGregorian(year,month,day);
  if(hour<0||hour>23||minute<0||minute>59)throw new Error('ساعت باید بین ۰۰:۰۰ تا ۲۳:۵۹ باشد.');
  const target=Date.UTC(greg.year,greg.month-1,greg.day,hour,minute,0);
  let candidate=target;
  for(let i=0;i<4;i++){
    const p=parts(tehranFormatter,new Date(candidate));
    const represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    const delta=target-represented;
    candidate+=delta;
    if(delta===0)break;
  }
  const check=parts(tehranFormatter,new Date(candidate));
  if(check.year!==greg.year||check.month!==greg.month||check.day!==greg.day||check.hour!==hour||check.minute!==minute)throw new Error('این ساعت در منطقه زمانی تهران معتبر نیست.');
  return new Date(candidate);
}
export function parseJalaliDateTime(value){
  if(typeof value!=='string')throw new TypeError('زمان باید به‌صورت متن ارسال شود.');
  const normalized=normalizeDigits(value).trim().replace(/[٫]/g,'.');
  const match=/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(normalized);
  if(!match)throw new Error('زمان را به‌شکل ۱۴۰۵/۰۹/۰۱ ۱۸:۳۰ وارد کنید.');
  const [,ys,mos,ds,hs,mis]=match;
  const date=tehranLocalToUtc({year:Number(ys),month:Number(mos),day:Number(ds),hour:Number(hs),minute:Number(mis)});
  const pad=n=>String(n).padStart(2,'0');
  return date.getUTCFullYear()+'-'+pad(date.getUTCMonth()+1)+'-'+pad(date.getUTCDate())+' '+pad(date.getUTCHours())+':'+pad(date.getUTCMinutes())+':00';
}
export const formatDateTime=formatTehranDateTime;
