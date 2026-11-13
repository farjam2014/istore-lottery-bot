require("dotenv").config();
const express=require("express"), mysql=require("mysql2/promise"), crypto=require("crypto"), path=require("path");
for(const k of ["BOT_TOKEN","WEBHOOK_SECRET","ADMIN_PASSWORD","SESSION_SECRET","ADMIN_ID","DB_HOST","DB_NAME","DB_USER","DB_PASSWORD"]){if(!process.env[k]){console.error("Missing env:",k);process.exit(1)}}
const {normalizePhone,validPhone,normalizeInstagram,validInstagram,validFullName,makeRaffleCode}=require("./domain");
const {createAdminTelegram}=require("./admin-telegram");
const {joinCampaign,approveManualPayment,rejectManualPayment}=require("./campaign-service");
const app=express();
const {patchAsyncRoutes,createErrorMiddleware}=require("./async-route");
patchAsyncRoutes(app);
app.disable("x-powered-by");
app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","same-origin");res.setHeader("X-Frame-Options","DENY");res.setHeader("Cache-Control","no-store");next()});
app.use(express.json({limit:"256kb"})); app.use(express.urlencoded({extended:false,limit:"16kb"}));
app.use(express.static(path.join(__dirname,"..","public"),{index:false}));
const db=mysql.createPool({host:process.env.DB_HOST,port:+(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,connectionLimit:8,charset:"utf8mb4"});
const token=process.env.BOT_TOKEN, secret=process.env.WEBHOOK_SECRET, adminPass=process.env.ADMIN_PASSWORD, sessionSecret=process.env.SESSION_SECRET;
async function registrationOpen(){
const [rows]=await db.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='registration_open' LIMIT 1");
return (rows[0]?.setting_value ?? (process.env.REGISTRATION_OPEN||"false")).toLowerCase()==="true";
}
const adminSearchModes = new Map();
async function telegramResponse(response,method){
if(!response.ok)throw new Error(`Telegram HTTP ${response.status} for ${method}`);
const data=await response.json();
if(!data.ok)throw new Error(data.description||method+" failed");
return data.result;
}
async function tg(method,payload){
const controller=new AbortController();
const timeout=setTimeout(()=>controller.abort(),15000);
try{
const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:controller.signal});
return await telegramResponse(response,method);
}catch(error){
if(error.name==="AbortError")throw new Error(`Telegram ${method} timed out after 15 seconds`);
throw error;
}finally{clearTimeout(timeout)}
}
async function tgDocument(chat,filename,content,mime){
const form=new FormData();
form.append("chat_id",String(chat));
form.append("document",new Blob([content],{type:mime}),filename);
const controller=new AbortController();
const timeout=setTimeout(()=>controller.abort(),30000);
try{
const response=await fetch(`https://api.telegram.org/bot${token}/sendDocument`,{method:"POST",body:form,signal:controller.signal});
return await telegramResponse(response,"sendDocument");
}catch(error){
if(error.name==="AbortError")throw new Error("Telegram sendDocument timed out after 30 seconds");
throw error;
}finally{clearTimeout(timeout)}
}
async function reply(chat,connection,text){return tg("sendMessage",{chat_id:chat,business_connection_id:connection,text})}
const adminTelegram=createAdminTelegram({db,tg,tgDocument,adminId:process.env.ADMIN_ID,registrationOpen});
const code=makeRaffleCode;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const csvCell=v=>{let x=String(v??"");if(/^[\s]*[=+\-@]/.test(x))x="'"+x;return '"'+x.replace(/"/g,'""')+'"'};
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function cookies(h=""){
const out={};for(const part of h.split(";")){const x=part.trim(),i=x.indexOf("=");if(i<1)continue;try{out[decodeURIComponent(x.slice(0,i))]=decodeURIComponent(x.slice(i+1))}catch{}}
return out;
}
function signed(v){return crypto.createHmac("sha256",sessionSecret).update(v).digest("hex")}
function isAdmin(req){const raw=cookies(req.headers.cookie||"").istore_admin;if(!raw||!raw.includes("."))return false;const [p,s]=raw.split(".");if(!equal(s,signed(p)))return false;try{return JSON.parse(Buffer.from(p,"base64url").toString()).exp>Date.now()}catch{return false}}
function admin(req,res,next){if(!isAdmin(req))return res.status(401).json({error:"لطفاً وارد پنل مدیریت شوید."});next()}
async function entry(uid){const [r]=await db.execute("SELECT * FROM lottery_entries WHERE telegram_user_id=?",[String(uid)]);return r[0]}
async function session(uid){const [r]=await db.execute("SELECT * FROM lottery_sessions WHERE telegram_user_id=?",[String(uid)]);const item=r[0];if(!item)return null;const age=Date.now()-new Date(item.updated_at).getTime();if(!Number.isFinite(age)||age>24*60*60*1000){await delSession(uid);return null}return item}
async function putSession(uid,chat,step,name,phone,conn,instagram=null,campaignId=null){await db.execute(`INSERT INTO lottery_sessions(telegram_user_id,campaign_id,chat_id,step,full_name,phone,instagram,business_connection_id) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE campaign_id=VALUES(campaign_id),chat_id=VALUES(chat_id),step=VALUES(step),full_name=VALUES(full_name),phone=VALUES(phone),instagram=VALUES(instagram),business_connection_id=VALUES(business_connection_id)`,[String(uid),campaignId, String(chat),step,name,phone,instagram,conn])}
async function delSession(uid){await db.execute("DELETE FROM lottery_sessions WHERE telegram_user_id=?",[String(uid)])}
async function saveEntry(uid,chat,name,phone,inst,businessConnection){
const conn=await db.getConnection();
try{
await conn.beginTransaction();
const [[registrationState]]=await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='registration_open' FOR UPDATE");
if(registrationState?.setting_value!=="true")throw Object.assign(new Error("REGISTRATION_CLOSED"),{code:"REGISTRATION_CLOSED"});
const [existingRows]=await conn.execute("SELECT * FROM lottery_entries WHERE telegram_user_id=? FOR UPDATE",[String(uid)]);
const existing=existingRows[0];
if(existing&&existing.status==="active"){await conn.rollback();return existing.raffle_code;}
const [duplicates]=await conn.execute("SELECT id FROM lottery_entries WHERE status='active' AND (phone=? OR LOWER(instagram)=LOWER(?)) AND telegram_user_id<>? LIMIT 1",[phone,inst,String(uid)]);
if(duplicates.length)throw Object.assign(new Error("DUPLICATE_CONTACT"),{code:"DUPLICATE_CONTACT"});
let assignedCode;
let entryId;
if(existing){
assignedCode=existing.raffle_code;
entryId=existing.id;
await conn.execute("UPDATE lottery_entries SET chat_id=?,full_name=?,phone=?,instagram=?,status='active',deleted_at=NULL,deletion_reason=NULL WHERE id=?",[String(chat),name,phone,inst,existing.id]);
}else{
assignedCode=code();
const [result]=await conn.execute("INSERT INTO lottery_entries(telegram_user_id,chat_id,full_name,phone,instagram,raffle_code,status) VALUES(?,?,?,?,?,?,'active')",[String(uid),String(chat),name,phone,inst,assignedCode]);
entryId=result.insertId;
await conn.execute("INSERT INTO lottery_code_history(entry_id,raffle_code,action,actor) VALUES(?,?,'assigned','system')",[entryId,assignedCode]);
}
const adminText=["🎉 شرکت‌کننده جدید قرعه‌کشی","","👤 نام: "+name,"📱 موبایل: "+phone,"📸 اینستاگرام: @"+inst,"🎟️ کد قرعه‌کشی: "+assignedCode].join("\n");
const userText="✅ ثبت‌نام کامل شد!\n🎟️ کد قرعه‌کشی شما: "+assignedCode+"\nاین کد را نگه دارید.";
const notificationEventId=crypto.randomUUID();
await conn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",["registration:"+entryId+":"+notificationEventId+":admin","admin_registration",JSON.stringify({method:"sendMessage",payload:{chat_id:process.env.ADMIN_ID,text:adminText}})]);
await conn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",["registration:"+entryId+":"+notificationEventId+":user","user_registration",JSON.stringify({method:"sendMessage",payload:{chat_id:String(chat),business_connection_id:String(businessConnection||""),text:userText}})]);
await conn.commit();
return assignedCode;
}catch(e){
await conn.rollback();
if(e.code==="ER_DUP_ENTRY"){
const [sameUser]=await db.execute("SELECT raffle_code,status FROM lottery_entries WHERE telegram_user_id=? LIMIT 1",[String(uid)]);
if(sameUser[0]?.status==="active")return sameUser[0].raffle_code;
throw Object.assign(new Error("DUPLICATE_CONTACT"),{code:"DUPLICATE_CONTACT"});
}
throw e;
}finally{conn.release()}
}

function makeContactPayload(uid){
const raw=String(uid)+"."+String(Date.now()+15*60*1000)+"."+crypto.randomBytes(4).toString("base64url");
const p=Buffer.from(raw).toString("base64url");
return p+"_"+signed(p).slice(0,16);
}
function verifyContactPayload(payload,uid){
try{
const i=payload.lastIndexOf("_");
if(i<1)return false;
const p=payload.slice(0,i),sig=payload.slice(i+1);
if(!equal(sig,signed(p).slice(0,16)))return false;
const [target,expiry]=Buffer.from(p,"base64url").toString().split(".");
return target===String(uid)&&Number(expiry)>Date.now();
}catch{return false}
}

function makeConfirmationPayload(uid,chat,connection){
const p=Buffer.from(JSON.stringify({uid:String(uid),chat:String(chat),connection:String(connection),exp:Date.now()+15*60*1000})).toString("base64url");
return "lc:"+p+"_"+signed(p).slice(0,16);
}
function verifyConfirmationPayload(payload,uid,chat,connection){
try{
if(typeof payload!=="string"||!payload.startsWith("lc:"))return false;
const data=payload.slice(3),i=data.lastIndexOf("_");
if(i<1)return false;
const p=data.slice(0,i),sig=data.slice(i+1);
if(!equal(sig,signed(p).slice(0,16)))return false;
const claims=JSON.parse(Buffer.from(p,"base64url").toString("utf8"));
return claims.uid===String(uid)&&claims.chat===String(chat)&&claims.connection===String(connection)&&Number.isFinite(claims.exp)&&claims.exp>Date.now();
}catch{return false}
}

async function manualPaymentInstructions(campaignId) {
const [[campaign]]=await db.execute("SELECT title,amount_minor,currency,settings FROM campaigns WHERE id=?",[campaignId]);
let settings=campaign?.settings||{};if(typeof settings==="string"){try{settings=JSON.parse(settings)}catch{settings={}}}
return "🧾 پرداخت کارت‌به‌کارت کمپین «"+campaign.title+"»\n\nمبلغ: "+Number(campaign.amount_minor).toLocaleString("fa-IR")+" "+campaign.currency+
"\nشماره کارت: "+String(settings.card_number||"ثبت نشده")+
"\nبه نام: "+String(settings.card_holder||"ثبت نشده")+
(settings.bank_name?"\nبانک: "+settings.bank_name:"")+
"\n\nپس از واریز، تصویر واضح رسید را همین‌جا در همین گفت‌وگو ارسال کنید. تا بررسی و تأیید مدیر، کدی صادر نمی‌شود.";
}
async function handleCallbackQuery(q){
if(!q?.id)return;
const uid=String(q.from?.id||"");
const chat=String(q.message?.chat?.id||"");
if(String(q.data||"").startsWith("pay:")){
if(uid!==String(process.env.ADMIN_ID)||q.message?.chat?.type!=="private")
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"دسترسی غیرمجاز",show_alert:true});
const [action,id]=String(q.data).split(":").slice(1);
if(!/^\\d+$/.test(id||"")||!["approve","reject"].includes(action))
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"درخواست نامعتبر",show_alert:true});
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"در حال بررسی..."});
try{
if(action==="approve"){
const result=await approveManualPayment({db,paymentId:id,reviewer:uid,codeSecret:process.env.CAMPAIGN_CODE_SECRET});
const [[recipient]]=await db.execute("SELECT p.telegram_user_id,cp.telegram_chat_id,cp.business_connection_id,c.title FROM campaign_payments cp JOIN campaign_entries e ON e.id=cp.entry_id JOIN participants p ON p.id=e.participant_id JOIN campaigns c ON c.id=e.campaign_id WHERE cp.id=?",[id]);
if(recipient)await tg("sendMessage",{chat_id:recipient.telegram_chat_id||recipient.telegram_user_id,...(recipient.business_connection_id?{business_connection_id:recipient.business_connection_id}:{}),text:"✅ پرداخت شما برای کمپین «"+recipient.title+"» تأیید شد.\\n🎟 کد اختصاصی شما: "+result.code});
await tg("editMessageCaption",{chat_id:chat,message_id:q.message.message_id,caption:(q.message.caption||"رسید پرداخت")+"\n\n✅ تأیید شد · کد: "+result.code,reply_markup:{inline_keyboard:[]}});
await audit(uid,"approve_campaign_payment","campaign_payment",id,{entry_id:result.entryId,code:result.code});
}else{
await rejectManualPayment({db,paymentId:id,reviewer:uid});
const [[recipient]]=await db.execute("SELECT p.telegram_user_id,cp.telegram_chat_id,cp.business_connection_id,c.title FROM campaign_payments cp JOIN campaign_entries e ON e.id=cp.entry_id JOIN participants p ON p.id=e.participant_id JOIN campaigns c ON c.id=e.campaign_id WHERE cp.id=?",[id]);
if(recipient)await tg("sendMessage",{chat_id:recipient.telegram_chat_id||recipient.telegram_user_id,...(recipient.business_connection_id?{business_connection_id:recipient.business_connection_id}:{}),text:"❌ رسید پرداخت کمپین «"+recipient.title+"» تأیید نشد. اگر فکر می‌کنید اشتباهی رخ داده، با پشتیبانی تماس بگیرید."});
await tg("editMessageCaption",{chat_id:chat,message_id:q.message.message_id,caption:(q.message.caption||"رسید پرداخت")+"\n\n❌ رد شد",reply_markup:{inline_keyboard:[]}});
await audit(uid,"reject_campaign_payment","campaign_payment",id,{});
}
return;
}catch(e){
console.error("Manual payment review failed:",e.message);
return tg("sendMessage",{chat_id:chat,text:e.code==="CAMPAIGN_FULL"?"ظرفیت کمپین تکمیل شده است.":"بررسی پرداخت انجام نشد؛ وضعیت پرداخت تغییر نکرد."});
}
}
if(String(q.data||"").startsWith("camp:select:")){
  const campaignId=String(q.data).slice("camp:select:".length);
  if(!/^\d+$/.test(campaignId))return tg("answerCallbackQuery",{callback_query_id:q.id,text:"کمپین نامعتبر است.",show_alert:true});
  const [[campaign]]=await db.execute("SELECT id,slug,title,payment_mode FROM campaigns WHERE id=? AND status='active'",[campaignId]);
  if(!campaign)return tg("answerCallbackQuery",{callback_query_id:q.id,text:"این کمپین دیگر فعال نیست.",show_alert:true});
  await tg("answerCallbackQuery",{callback_query_id:q.id,text:"در حال بررسی اطلاعات..."});
  const connection=String(q.message?.business_connection_id||"");
  const [[profile]]=await db.execute("SELECT full_name,phone,instagram FROM participants WHERE telegram_user_id=?",[uid]);
  if(profile){
    try{
      const result=await joinCampaign({db,telegramUserId:uid,fullName:profile.full_name,phone:profile.phone,instagram:profile.instagram,chatId:chat,campaignSlug:campaign.slug,businessConnectionId:connection,codeSecret:process.env.CAMPAIGN_CODE_SECRET});
      const message=result.code?"✅ ثبت‌نام شما در «"+campaign.title+"» کامل شد.\n🎟 کد اختصاصی: "+result.code:
        result.status==="pending_payment"?await manualPaymentInstructions(campaign.id):"شما قبلاً در این کمپین ثبت‌نام کرده‌اید.";
      return tg("sendMessage",{chat_id:chat,business_connection_id:connection,text:message});
    }catch(e){
      const message=e.code==="CAMPAIGN_FULL"?"ظرفیت این کمپین تکمیل شده است.":e.code==="CAMPAIGN_NOT_OPEN"?"این کمپین دیگر قابل ثبت‌نام نیست.":"ثبت‌نام انجام نشد؛ لطفاً بعداً تلاش کنید.";
      return tg("sendMessage",{chat_id:chat,business_connection_id:connection,text:message});
    }
  }
  await putSession(uid,chat,"name",null,null,connection,null,Number(campaign.id));
  return tg("sendMessage",{chat_id:chat,business_connection_id:connection,text:"🎉 برای شرکت در «"+campaign.title+"»، نام و نام خانوادگی خود را ارسال کنید.\nبرای لغو، «لغو» را بفرستید."});
}
if(verifyConfirmationPayload(q.data||"",uid,chat,q.message?.business_connection_id||"")){
const s=await session(uid);
if(!uid||!s||s.step!=="awaiting_confirmation"||String(s.chat_id)!==chat||String(s.business_connection_id)!==String(q.message?.business_connection_id||"")){
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"این درخواست معتبر نیست یا قبلاً استفاده شده است.",show_alert:true});
}
if(!s.campaign_id&&!await registrationOpen()){
await delSession(uid);
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"مهلت ثبت‌نام به پایان رسیده است.",show_alert:true});
}
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"در حال ثبت نهایی..."});
try{
if(s.campaign_id){
  const [[campaign]]=await db.execute("SELECT slug,title FROM campaigns WHERE id=? AND status='active'",[s.campaign_id]);
  if(!campaign)throw Object.assign(new Error("CAMPAIGN_NOT_OPEN"),{code:"CAMPAIGN_NOT_OPEN"});
  const result=await joinCampaign({db,telegramUserId:uid,fullName:s.full_name,phone:s.phone,instagram:s.instagram,chatId:s.chat_id,campaignSlug:campaign.slug,businessConnectionId:s.business_connection_id,codeSecret:process.env.CAMPAIGN_CODE_SECRET});
  await delSession(uid);
  const text=result.code?"✅ ثبت‌نام شما در «"+campaign.title+"» کامل شد.\n🎟 کد اختصاصی: "+result.code:
    result.status==="pending_payment"?await manualPaymentInstructions(s.campaign_id):"شما قبلاً در این کمپین ثبت‌نام کرده‌اید.";
  return tg("sendMessage",{chat_id:s.chat_id,business_connection_id:s.business_connection_id,text});
}
await saveEntry(uid,s.chat_id,s.full_name,s.phone,s.instagram,s.business_connection_id);
await delSession(uid);
return;
}catch(e){
console.error("Lottery confirmation error:",e.message);
const msg=e.code==="DUPLICATE_CONTACT"?"❌ این شماره موبایل یا آیدی اینستاگرام قبلاً با حساب دیگری ثبت شده است. برای بررسی با پشتیبانی تماس بگیرید.":e.code==="REGISTRATION_CLOSED"||e.code==="CAMPAIGN_NOT_OPEN"?"❌ مهلت ثبت‌نام این کمپین به پایان رسیده است.":e.code==="CAMPAIGN_FULL"?"❌ ظرفیت کمپین تکمیل شده است.":"❌ ثبت نهایی با خطا مواجه شد. اطلاعات شما حذف نشده است؛ لطفاً کمی بعد دوباره تلاش کنید.";
return tg("sendMessage",{chat_id:s.chat_id,business_connection_id:s.business_connection_id,text:msg});
}
}
const adminHandled=await adminTelegram.handleCallback(q);if(adminHandled!==false)return adminHandled;
if(uid!==String(process.env.ADMIN_ID)||q.message?.chat?.type!=="private"){
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"دسترسی غیرمجاز",show_alert:true});
}
if(!["admin:stats","admin:export","admin:search","admin:search:phone","admin:search:instagram","admin:search:code"].includes(q.data)){
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"دکمه نامعتبر است.",show_alert:true});
}
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"در حال اجرا..."});
if(q.data==="admin:search"){
return tg("sendMessage",{chat_id:chat,text:"🔎 روش جستجوی شرکت‌کننده را انتخاب کنید:",reply_markup:{inline_keyboard:[
[{text:"📱 جستجو با شماره موبایل",callback_data:"admin:search:phone"}],
[{text:"📸 جستجو با آیدی اینستاگرام",callback_data:"admin:search:instagram"}],
[{text:"🎟️ جستجو با کد قرعه‌کشی",callback_data:"admin:search:code"}]
]}});
}
const searchPrompts={"admin:search:phone":["phone","شماره موبایل شرکت‌کننده را وارد کنید:"],"admin:search:instagram":["instagram","آیدی اینستاگرام را بدون @ وارد کنید:"],"admin:search:code":["raffle_code","کد قرعه‌کشی را وارد کنید:"]};
if(searchPrompts[q.data]){
adminSearchModes.set(uid,searchPrompts[q.data][0]);
return tg("sendMessage",{chat_id:chat,text:"🔎 "+searchPrompts[q.data][1]});
}
if(q.data==="admin:stats"){
try{
const [[a]]=await db.query("SELECT COUNT(*) AS total, COUNT(raffle_code) AS codes, COUNT(DISTINCT raffle_code) AS unique_codes FROM lottery_entries WHERE status='active'");
const [[b]]=await db.query("SELECT COUNT(*) AS today FROM lottery_entries WHERE status='active' AND DATE(created_at)=CURDATE()");
return tg("sendMessage",{chat_id:chat,text:"📊 آمار قرعه‌کشی iStore\n\n👥 شرکت‌کنندگان: "+a.total+"\n🎟 تعداد کدها: "+a.codes+"\n🔑 کدهای یکتا: "+a.unique_codes+"\n📅 ثبت‌نام امروز: "+b.today});
}catch(e){
console.error("Callback stats error:",e.message);
return tg("sendMessage",{chat_id:chat,text:"خطا در دریافت آمار. گزارش خطا در سرور ثبت شد."});
}
}
try{
const [rows]=await db.query("SELECT full_name,phone,instagram,raffle_code,created_at FROM lottery_entries WHERE status='active' ORDER BY created_at DESC");
const cell=csvCell;
const csv="\uFEFF"+[["نام و نام خانوادگی","موبایل","اینستاگرام","کد قرعه‌کشی","زمان ثبت"],...rows.map(x=>[x.full_name,x.phone,"@"+String(x.instagram||"").replace(/^@/,""),x.raffle_code,x.created_at])].map(row=>row.map(cell).join(",")).join("\r\n");
return await tgDocument(chat,"istore-lottery.csv",csv,"text/csv;charset=utf-8");
}catch(e){
console.error("Callback export error:",e.message);
return tg("sendMessage",{chat_id:chat,text:"❌ ارسال فایل ناموفق بود. گزارش خطا در سرور ثبت شد."});
}
}

async function handlePrivateUpdate(update){
const m=update.message;
if(!m?.from||m.from.is_bot||!m.chat||m.chat.type!=="private")return;
const uid=String(m.from.id),chat=String(m.chat.id);

const adminHandled=await adminTelegram.handleMessage(m);if(adminHandled!==false)return adminHandled;

if(m.text?.trim()==="پنل" || m.text?.trim().toLowerCase()==="/panel"){
if(uid!==String(process.env.ADMIN_ID))return;
adminSearchModes.delete(uid);
return tg("sendMessage",{chat_id:chat,text:"🛠 پنل مدیریت iStore\n\nیکی از گزینه‌های زیر را انتخاب کنید:",reply_markup:{inline_keyboard:[
[{text:"📊 آمار لاتاری",callback_data:"admin:stats"}],
[{text:"📥 خروجی شرکت‌کنندگان",callback_data:"admin:export"}],
[{text:"🔎 جستجوی شرکت‌کننده",callback_data:"admin:search"}]
]}});
}

if(uid===String(process.env.ADMIN_ID)&&adminSearchModes.has(uid)&&typeof m.text==="string"){
const mode=adminSearchModes.get(uid);
adminSearchModes.delete(uid);
let value=m.text.trim();
value=value.replace(/[۰-۹٠-٩]/g,c=>String("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩".indexOf(c)%10));
let column=mode;
if(mode==="phone")value=normalizePhone(value);
if(mode==="instagram")value=normalizeInstagram(value);
if(mode==="raffle_code")value=value.toUpperCase();
if(!value||value.length>100){
return tg("sendMessage",{chat_id:chat,text:"❌ مقدار جستجو نامعتبر است. دوباره از پنل اقدام کنید."});
}
if(mode==="phone"&&!validPhone(value)){
return tg("sendMessage",{chat_id:chat,text:"❌ شماره موبایل معتبر نیست. دوباره از پنل اقدام کنید."});
}
if(mode==="instagram"&&!validInstagram(value)){
return tg("sendMessage",{chat_id:chat,text:"❌ آیدی اینستاگرام معتبر نیست. دوباره از پنل اقدام کنید."});
}
try{
const [rows]=await db.execute(
"SELECT full_name,phone,instagram,raffle_code,created_at FROM lottery_entries WHERE status='active' AND "+column+" = ? ORDER BY created_at DESC LIMIT 10",
[mode==="instagram"?value:value]
);
if(!rows.length)return tg("sendMessage",{chat_id:chat,text:"🔍 هیچ شرکت‌کننده‌ای با این مشخصات پیدا نشد."});
const messages=rows.map((x,i)=>[
"👤 شرکت‌کننده "+(i+1),
"نام: "+(x.full_name||"-"),
"📱 موبایل: "+(x.phone||"-"),
"📸 اینستاگرام: @"+String(x.instagram||"").replace(/^@/,""),
"🎟️ کد قرعه‌کشی: "+(x.raffle_code||"-"),
"🕒 زمان ثبت: "+(x.created_at||"-")
].join("\n"));
const result="✅ تعداد نتایج نمایش‌داده‌شده: "+rows.length+"\n\n"+messages.join("\n\n──────────\n\n")+(rows.length===10?"\n\n⚠️ حداکثر ۱۰ نتیجه نمایش داده شد.":"");
return tg("sendMessage",{chat_id:chat,text:result});
}catch(e){
console.error("Admin search error:",e.message);
return tg("sendMessage",{chat_id:chat,text:"❌ خطا در جستجو. گزارش خطا در سرور ثبت شد."});
}
}

if(m.text?.trim().toLowerCase()==="/stats"){
if(uid!==String(process.env.ADMIN_ID))return;
try{
const [[a]]=await db.query("SELECT COUNT(*) AS total, COUNT(raffle_code) AS codes, COUNT(DISTINCT raffle_code) AS unique_codes FROM lottery_entries WHERE status='active'");
const [[b]]=await db.query("SELECT COUNT(*) AS today FROM lottery_entries WHERE status='active' AND DATE(created_at)=CURDATE()");
return tg("sendMessage",{chat_id:chat,text:"📊 آمار قرعه‌کشی iStore\n\n👥 شرکت‌کنندگان: "+a.total+"\n🎟 تعداد کدها: "+a.codes+"\n🔑 کدهای یکتا: "+a.unique_codes+"\n📅 ثبت‌نام امروز: "+b.today});
}catch(e){
console.error("Stats error:",e.message);
return tg("sendMessage",{chat_id:chat,text:"خطا در دریافت آمار. گزارش خطا در سرور ثبت شد."});
}
}


if(typeof m.text==="string" && /^\/export(?:@\w+)?$/i.test(m.text.trim())){
if(uid!==String(process.env.ADMIN_ID))return;
try{
const [rows]=await db.query("SELECT full_name,phone,instagram,raffle_code,created_at FROM lottery_entries WHERE status='active' ORDER BY created_at DESC");
const cell=csvCell;
const csv="\uFEFF"+[["نام و نام خانوادگی","موبایل","اینستاگرام","کد قرعه‌کشی","زمان ثبت"],...rows.map(x=>[x.full_name,x.phone,"@"+String(x.instagram||"").replace(/^@/,""),x.raffle_code,x.created_at])].map(row=>row.map(cell).join(",")).join("\r\n");
await tgDocument(chat,"istore-lottery.csv",csv,"text/csv;charset=utf-8");
}catch(e){
console.error("Private export error:",e.message);
return tg("sendMessage",{chat_id:chat,text:"❌ ارسال فایل ناموفق بود. گزارش خطا در سرور ثبت شد."});
}
return;
}

if(m.contact){
if(!m.contact.user_id||String(m.contact.user_id)!==uid){
return tg("sendMessage",{chat_id:chat,text:"❌ لطفاً فقط شماره خودتان را با دکمه ارسال کنید.",reply_markup:{remove_keyboard:true}});
}
const s=await session(uid);
if(!s||s.step!=="awaiting_contact"){
return tg("sendMessage",{chat_id:chat,text:"درخواست ثبت شماره معتبر یا فعال نیست. به پی‌وی فروشگاه برگردید و دوباره «لاتاری» را ارسال کنید.",reply_markup:{remove_keyboard:true}});
}
const phone=normalizePhone(m.contact.phone_number||"");
if(!validPhone(phone)){
return tg("sendMessage",{chat_id:chat,text:"شماره دریافت‌شده معتبر نیست. دوباره شماره خودتان را ارسال کنید."});
}
await putSession(uid,s.chat_id,"instagram",s.full_name,phone,s.business_connection_id,null,s.campaign_id||null);
await reply(s.chat_id,s.business_connection_id,"✅ شماره موبایل شما دریافت شد.\nحالا آیدی اینستاگرام خود را بدون @ وارد کنید؛ مثال: example");
return tg("sendMessage",{chat_id:chat,text:"✅ شماره شما با موفقیت ثبت شد.\n\nبه گفتگوی قبلی با فروشگاه برگردید و آیدی اینستاگرام خود را ارسال کنید.",reply_markup:{remove_keyboard:true}});
}

if(typeof m.text==="string"){
const match=m.text.trim().match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/);
if(match&&match[1]){
if(!verifyContactPayload(match[1],uid)){
return tg("sendMessage",{chat_id:chat,text:"❌ لینک نامعتبر یا منقضی شده است. از پی‌وی فروشگاه لینک جدید بگیرید."});
}
const s=await session(uid);
if(!s||s.step!=="awaiting_contact"){
return tg("sendMessage",{chat_id:chat,text:"درخواست ثبت شماره فعال نیست. به پی‌وی فروشگاه برگردید و دوباره «لاتاری» را ارسال کنید."});
}
return tg("sendMessage",{
chat_id:chat,
text:"برای ثبت شماره، دکمه زیر را بزنید و مخاطب خودتان را ارسال کنید:",
reply_markup:{keyboard:[[{text:"📱 اشتراک‌گذاری شماره من",request_contact:true}]],resize_keyboard:true,one_time_keyboard:true}
});
}
}
}

async function handleUpdate(update){const m=update.business_message;if(!m?.from||!m.chat||m.from.is_bot||!m.business_connection_id)return;
const uid=String(m.from.id),chat=String(m.chat.id),conn=m.business_connection_id,t=String(m.text||"").trim(),lower=t.toLowerCase();
if(Array.isArray(m.photo)&&m.photo.length){
const [[pending]]=await db.execute(
"SELECT cp.id,cp.amount_minor,cp.currency,c.title,pt.full_name,pt.phone,pt.instagram FROM campaign_payments cp JOIN campaign_entries e ON e.id=cp.entry_id JOIN participants pt ON pt.id=e.participant_id JOIN campaigns c ON c.id=e.campaign_id WHERE pt.telegram_user_id=? AND cp.status='pending' AND cp.mode='manual_transfer' ORDER BY cp.id DESC LIMIT 1",
[uid]);
if(!pending)return reply(chat,conn,"برای شما پرداخت کارت‌به‌کارتِ در انتظار رسید پیدا نشد. ابتدا از فهرست کمپین‌ها ثبت‌نام کنید.");
const photo=m.photo[m.photo.length-1];
await db.execute(
"INSERT INTO campaign_payment_proofs(payment_id,storage_key,mime_type,file_size,sha256,telegram_file_id,telegram_file_unique_id) VALUES(?,?,?,?,?,?,?)",
[pending.id,"telegram:"+photo.file_id,"image/jpeg",Number(photo.file_size||0),crypto.createHash("sha256").update(String(photo.file_unique_id||photo.file_id)).digest("hex"),photo.file_id,photo.file_unique_id||null]);
await tg("sendPhoto",{chat_id:process.env.ADMIN_ID,photo:photo.file_id,caption:"🧾 رسید کارت‌به‌کارت جدید\\nکمپین: "+pending.title+"\nنام: "+pending.full_name+"\nموبایل: "+pending.phone+"\\nاینستاگرام: @"+pending.instagram+"\nمبلغ: "+Number(pending.amount_minor).toLocaleString("fa-IR")+" "+pending.currency+"\nشناسه پرداخت: "+pending.id,reply_markup:{inline_keyboard:[[{text:"✅ تأیید و صدور کد",callback_data:"pay:approve:"+pending.id},{text:"❌ رد رسید",callback_data:"pay:reject:"+pending.id}]]}});
return reply(chat,conn,"📨 تصویر رسید دریافت شد و برای مدیر ارسال شد. پس از بررسی نتیجه به شما اطلاع داده می‌شود. تا قبل از تأیید، کدی صادر نخواهد شد.");
}
if(!m.text)return;
if(lower==="/export" || lower.startsWith("/export@")){
if(String(m.from.id)!==String(process.env.ADMIN_ID))return;
try{
const [rows]=await db.query("SELECT full_name,phone,instagram,raffle_code,created_at FROM lottery_entries WHERE status='active' ORDER BY created_at DESC");
const csv="\uFEFF"+[["نام و نام خانوادگی","موبایل","اینستاگرام","کد قرعه‌کشی","زمان ثبت"],...rows.map(x=>[x.full_name,x.phone,"@"+String(x.instagram||"").replace(/^@/,""),x.raffle_code,x.created_at])].map(row=>row.map(csvCell).join(",")).join("\r\n");
const boundary="----lottery"+Date.now();
const file=Buffer.from(csv,"utf8");
const head=Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\"business_connection_id\"\r\n\r\n"+conn+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n"+chat+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"document\"; filename=\"istore-lottery.csv\"\r\nContent-Type: text/csv; charset=utf-8\r\n\r\n");
const tail=Buffer.from("\r\n--"+boundary+"--\r\n");
const body=Buffer.concat([head,file,tail]);
const response=await fetch("https://api.telegram.org/bot"+token+"/sendDocument",{method:"POST",headers:{"Content-Type":"multipart/form-data; boundary="+boundary},body});
const result=await response.json();
if(!result.ok)throw new Error(result.description||"ارسال فایل ناموفق بود");
}catch(e){console.error("Export error:",e.message);await reply(chat,conn,"ارسال فایل ناموفق بود. گزارش خطا در سرور ثبت شد.");}
return;
}

if(lower==="/stats"){
if(String(m.from.id)!==String(process.env.ADMIN_ID))return;
const [[a]]=await db.query("SELECT COUNT(*) AS total, COUNT(raffle_code) AS codes, COUNT(DISTINCT raffle_code) AS unique_codes FROM lottery_entries WHERE status='active'");
const [[b]]=await db.query("SELECT COUNT(*) AS today FROM lottery_entries WHERE status='active' AND DATE(created_at)=CURDATE()");
return reply(chat,conn,"📊 آمار قرعه‌کشی iStore\n\n👥 شرکت‌کنندگان: "+a.total+"\n🎟 تعداد کدها: "+a.codes+"\n🔑 کدهای یکتا: "+a.unique_codes+"\n📅 ثبت‌نام امروز: "+b.today);
}
if(lower==="/cancel"||t==="لغو"){await delSession(uid);return reply(chat,conn,"ثبت‌نام لغو شد. برای شروع دوباره «لاتاری» را بفرستید.")}
if(lower==="لاتاری"||lower==="/start"){
const [campaigns]=await db.execute("SELECT id,title,payment_mode FROM campaigns WHERE status='active' AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW()) ORDER BY id DESC LIMIT 20");
if(campaigns.length){
const rows=campaigns.map(c=>[{text:(c.payment_mode==="free"?"🎁 ":"🧾 ")+c.title,callback_data:"camp:select:"+c.id}]);
return tg("sendMessage",{chat_id:chat,business_connection_id:conn,text:"🎉 کمپین موردنظر برای شرکت را انتخاب کنید:",reply_markup:{inline_keyboard:rows}});
}
if(!await registrationOpen())return reply(chat,conn,"در حال حاضر کمپین فعالی برای ثبت‌نام وجود ندارد.");
const old=await entry(uid);
if(old&&old.status==="active")return reply(chat,conn,"شما قبلاً ثبت‌نام کرده‌اید.\nکد شما: "+old.raffle_code);
await putSession(uid,chat,"name",null,null,conn);
return reply(chat,conn,"🎉 به قرعه‌کشی iStore خوش آمدید\n\nنام و نام خانوادگی خود را ارسال کنید تا مراحل ثبت‌نام آغاز شود.\n\nبرای لغو ثبت‌نام، عبارت «لغو» را ارسال کنید.");
}
const s=await session(uid);if(!s){if(t!=="لغو")return reply(chat,conn,"مرحله قبلی ثبت‌نام منقضی شده است. برای شروع دوباره کلمه «لاتاری» را ارسال کنید.");return}if(String(s.chat_id)!==chat)return;if(s.campaign_id){const [[activeCampaign]]=await db.execute("SELECT id FROM campaigns WHERE id=? AND status='active' AND (starts_at IS NULL OR starts_at<=NOW()) AND (ends_at IS NULL OR ends_at>=NOW())",[s.campaign_id]);if(!activeCampaign){await delSession(uid);return reply(chat,conn,"ثبت‌نام این کمپین بسته شده است.")}}else if(!await registrationOpen()){await delSession(uid);return reply(chat,conn,"ثبت‌نام فعلاً بسته است.");}
if(s.step==="name"){if(!validFullName(t))return reply(chat,conn,"لطفاً نام و نام خانوادگی معتبر وارد کنید.");const fullName=t.trim().replace(/\s+/g," ");await putSession(uid,chat,"awaiting_contact",fullName,null,conn,null,s.campaign_id||null);const link="https://t.me/istorelotterybot?start="+makeContactPayload(uid);return tg("sendMessage",{chat_id:chat,business_connection_id:conn,text:"نام شما ثبت شد. برای ارسال شماره موبایل، دکمه زیر را بزنید و در ربات بازشده گزینه «اشتراک‌گذاری شماره من» را انتخاب کنید.",reply_markup:{inline_keyboard:[[{text:"📱 ارسال شماره موبایل",url:link}]]}})}
if(s.step==="phone"){await putSession(uid,chat,"awaiting_contact",s.full_name,null,conn,s.instagram||null,s.campaign_id||null);const link="https://t.me/istorelotterybot?start="+makeContactPayload(uid);return tg("sendMessage",{chat_id:chat,business_connection_id:conn,text:"برای امنیت ثبت‌نام، شماره‌ای که قبلاً به‌صورت متنی وارد می‌شد پذیرفته نیست. لطفاً شماره متعلق به خودتان را از طریق دکمه زیر و در ربات ارسال کنید.",reply_markup:{inline_keyboard:[[{text:"📱 تأیید شماره موبایل",url:link}]]}})}
if(s.step==="awaiting_confirmation"){
return tg("sendMessage",{chat_id:chat,business_connection_id:conn,text:"برای تکمیل ثبت‌نام، دکمه تأیید زیر را بزنید.",reply_markup:{inline_keyboard:[[{text:"ادامه ثبت‌نام",callback_data:makeConfirmationPayload(uid,chat,conn)}]]}});
}
if(s.step==="instagram"){
const inst=normalizeInstagram(t);
if(!validInstagram(inst))return reply(chat,conn,"آیدی نامعتبر است؛ فقط حروف انگلیسی، عدد، نقطه و زیرخط مجاز است.");
const old=await entry(uid);
if(old&&old.status==="active"){await delSession(uid);return reply(chat,conn,"شما قبلاً ثبت‌نام کرده‌اید. کد شما: "+old.raffle_code)}
try{
if(!process.env.CONTACT_PHONE)throw new Error("CONTACT_PHONE is not configured");
await tg("sendContact",{
chat_id:chat,
business_connection_id:conn,
phone_number:process.env.CONTACT_PHONE,
first_name:"موبایل مهدی زاده",
last_name:"iStore"
});
}catch(e){console.error("Contact card error:",e.message);return reply(chat,conn,"⚠️ فعلاً ارسال کارت مخاطب ممکن نشد. لطفاً دوباره آیدی اینستاگرام خود را ارسال کنید؛ اطلاعات قبلی حفظ شده است.")}
await putSession(uid,chat,"awaiting_confirmation",s.full_name,s.phone,conn,inst,s.campaign_id||null);
return tg("sendMessage",{
chat_id:chat,
business_connection_id:conn,
text:"📇 کارت مخاطب فروشگاه ارسال شد. برای ادامه ثبت‌نام و دریافت کد قرعه‌کشی، دکمه زیر را بزن.",
reply_markup:{inline_keyboard:[[
{text:"ادامه ثبت‌نام",callback_data:makeConfirmationPayload(uid,chat,conn)}
]]}
});
}}
app.get("/",(_q,r)=>r.sendFile(path.join(__dirname,"..","public","index.html")));
app.get("/health",async(_q,r)=>{try{await db.query("SELECT 1");r.json({ok:true,database:"connected"})}catch{r.status(503).json({ok:false,database:"unavailable"})}});
app.get("/admin/login",(_q,r)=>r.sendFile(path.join(__dirname,"..","public","login.html")));
const loginAttempts=new Map();
app.post("/admin/login",(q,r)=>{
const ip=String(q.ip||q.socket.remoteAddress||"unknown").slice(0,128),now=Date.now(),a=loginAttempts.get(ip)||{count:0,until:0};
if(!loginAttempts.has(ip)&&loginAttempts.size>=10000){
const oldest=loginAttempts.keys().next().value;
if(oldest!==undefined)loginAttempts.delete(oldest);
}
if(a.until>now&&a.count>=8)return r.status(429).send("تعداد تلاش زیاد است. چند دقیقه دیگر دوباره امتحان کنید.");
if(!equal(q.body.password||"",adminPass)){a.count++;a.until=a.count>=8?now+15*60*1000:now+5*60*1000;loginAttempts.set(ip,a);return r.status(401).send("رمز نادرست است؛ دوباره تلاش کنید.")}
loginAttempts.delete(ip);const p=Buffer.from(JSON.stringify({exp:Date.now()+4*3600000})).toString("base64url");r.setHeader("Set-Cookie",`istore_admin=${p}.${signed(p)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=14400`);r.redirect("/admin")});
app.post("/admin/logout",(_q,r)=>{r.setHeader("Set-Cookie","istore_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");r.redirect("/admin/login")});
app.get("/admin",(q,r)=>isAdmin(q)?r.sendFile(path.join(__dirname,"..","public","admin.html")):r.redirect("/admin/login"));
app.get("/api/admin/campaigns",admin,async(_q,r)=>{
  const [rows]=await db.query(`
    SELECT c.id,c.slug,c.title,c.status,c.starts_at,c.ends_at,c.capacity,c.payment_mode,
           c.amount_minor,c.currency,c.created_at,
           COUNT(DISTINCT e.id) AS entries_count, EXISTS(SELECT 1 FROM campaign_draws cd WHERE cd.campaign_id=c.id) AS drawn,
           SUM(e.status='active') AS active_count,
           SUM(e.status='pending_payment') AS pending_payment_count
    FROM campaigns c LEFT JOIN campaign_entries e ON e.campaign_id=c.id
    GROUP BY c.id ORDER BY c.id DESC
  `);
  r.json({campaigns:rows});
});
app.get("/api/admin/campaigns/:id/entries",admin,async(q,r)=>{
  const id=Number(q.params.id),limit=Math.min(100,Math.max(1,Math.floor(Number(q.query.limit)||50))),offset=Math.max(0,Math.floor(Number(q.query.offset)||0));
  const term=String(q.query.q||"").trim().slice(0,80);
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(offset))return r.status(400).json({error:"شناسه یا صفحه‌بندی نامعتبر است."});
  const params=[id],where=["e.campaign_id=?"];
  if(term){where.push("(pt.full_name LIKE ? OR pt.phone LIKE ? OR pt.instagram LIKE ? OR ic.code LIKE ?)");const like="%"+term+"%";params.push(like,like,like,like)}
  const filter=where.join(" AND ");
  const [[count]]=await db.execute(`SELECT COUNT(*) total FROM campaign_entries e JOIN participants pt ON pt.id=e.participant_id LEFT JOIN issued_codes ic ON ic.entry_id=e.id AND ic.status='active' WHERE ${filter}`,params);
  const [rows]=await db.execute(
    `SELECT e.id,e.status,e.payment_status,e.created_at,pt.full_name,pt.phone,pt.instagram,ic.code
     FROM campaign_entries e JOIN participants pt ON pt.id=e.participant_id
     LEFT JOIN issued_codes ic ON ic.entry_id=e.id AND ic.status='active'
     WHERE ${filter} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    [...params,limit,offset]
  );
  r.json({total:Number(count.total),entries:rows,limit,offset});
});
app.get("/api/admin/campaigns/:id/entries.csv",admin,async(q,r)=>{
  const id=Number(q.params.id);
  if(!Number.isSafeInteger(id)||id<1)return r.status(400).json({error:"شناسه کمپین نامعتبر است."});
  const [[campaign]]=await db.execute("SELECT slug FROM campaigns WHERE id=?",[id]);
  if(!campaign)return r.status(404).json({error:"کمپین پیدا نشد."});
  const [rows]=await db.execute(
    `SELECT pt.full_name,pt.phone,pt.instagram,e.status,e.payment_status,ic.code,e.created_at
     FROM campaign_entries e JOIN participants pt ON pt.id=e.participant_id
     LEFT JOIN issued_codes ic ON ic.entry_id=e.id AND ic.status='active'
     WHERE e.campaign_id=? ORDER BY e.id`,[id]
  );
  if(rows.length>100000)return r.status(413).json({error:"تعداد رکوردها برای خروجی مستقیم زیاد است؛ از فیلتر و صفحه‌بندی استفاده کنید."});
  const csv=[["نام","موبایل","اینستاگرام","وضعیت","وضعیت پرداخت","کد","زمان ثبت"],...rows.map(x=>[x.full_name,x.phone,x.instagram,x.status,x.payment_status,x.code,x.created_at])].map(row=>row.map(csvCell).join(",")).join("\r\n");
  r.setHeader("Content-Type","text/csv; charset=utf-8");
  r.setHeader("Content-Disposition",`attachment; filename="campaign-${id}-entries.csv"`);
  r.send("\uFEFF"+csv);
});
app.post("/api/admin/campaigns",admin,async(q,r)=>{
  const slug=String(q.body.slug||"").trim().toLowerCase();
  const title=String(q.body.title||"").trim();
  const capacity=q.body.capacity===null||q.body.capacity===""?null:Number(q.body.capacity);
  const mode=q.body.payment_mode||"free";
  const amount=Number(q.body.amount_minor||0);
  const currency=String(q.body.currency||"IRR").toUpperCase();
  if(!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)||title.length<3||title.length>160)
    return r.status(400).json({error:"شناسه یا عنوان کمپین معتبر نیست."});
  if(capacity!==null&&(!Number.isSafeInteger(capacity)||capacity<1||capacity>10000000))
    return r.status(400).json({error:"ظرفیت باید عدد صحیح مثبت یا خالی باشد."});
  if(!["free","manual_transfer"].includes(mode))
    return r.status(400).json({error:"روش پرداخت نامعتبر است."});
  const cardNumber=String(q.body.card_number||"").replace(/\s+/g,"");
  const cardHolder=String(q.body.card_holder||"").trim();
  const bankName=String(q.body.bank_name||"").trim();
  if(mode==="manual_transfer"&&(!/^\d{16}$/.test(cardNumber)||cardHolder.length<3||cardHolder.length>100))
    return r.status(400).json({error:"برای کارت‌به‌کارت، شماره کارت ۱۶ رقمی و نام صاحب کارت الزامی است."});
  if(!Number.isSafeInteger(amount)||amount<0||! /^[A-Z]{3}$/.test(currency)||(mode==="free"&&amount!==0)||(mode==="manual_transfer"&&amount<1))
    return r.status(400).json({error:"مبلغ یا واحد پول نامعتبر است."});
  try{
    const [result]=await db.execute(
      "INSERT INTO campaigns(slug,title,status,capacity,payment_mode,amount_minor,currency,settings) VALUES(?,?,'draft',?,?,?,?,?)",
      [slug,title,capacity,mode,amount,currency,JSON.stringify(mode==="manual_transfer"?{card_number:cardNumber,card_holder:cardHolder,bank_name:bankName}:{})]
    );
    await db.execute("INSERT IGNORE INTO campaign_sequences(campaign_id,last_sequence) VALUES(?,0)",[result.insertId]);
    await audit(process.env.ADMIN_ID,"create_campaign","campaign",result.insertId,{slug,title,capacity,payment_mode:mode});
    r.status(201).json({id:result.insertId,slug,status:"draft"});
  }catch(e){
    if(e.code==="ER_DUP_ENTRY")return r.status(409).json({error:"این شناسه کمپین قبلاً استفاده شده است."});
    throw e;
  }
});
app.post("/api/admin/campaigns/:id/status",admin,async(q,r)=>{
  const status=String(q.body.status||"");
  if(!["draft","active","paused","closed","archived"].includes(status))
    return r.status(400).json({error:"وضعیت کمپین معتبر نیست."});
  const conn=await db.getConnection();
  try{
    await conn.beginTransaction();
    const [[campaign]]=await conn.execute("SELECT id,status FROM campaigns WHERE id=? FOR UPDATE",[q.params.id]);
    if(!campaign){await conn.rollback();return r.status(404).json({error:"کمپین پیدا نشد."})}
    if(campaign.status==="archived"&&status!=="archived"){await conn.rollback();return r.status(409).json({error:"کمپین آرشیوشده قابل بازگردانی نیست."})}
    if(status==="archived"){
      const [[pending]]=await conn.execute("SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status='pending_payment'",[q.params.id]);
      if(Number(pending.total)){await conn.rollback();return r.status(409).json({error:"تا تعیین تکلیف پرداخت‌های معلق، کمپین آرشیو نمی‌شود."})}
    }
    await conn.execute("UPDATE campaigns SET status=? WHERE id=?",[status,q.params.id]);
    await conn.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",[String(process.env.ADMIN_ID),"campaign_status","campaign",String(q.params.id),JSON.stringify({from:campaign.status,to:status})]);
    await conn.commit();r.json({ok:true,status});
  }catch(e){await conn.rollback();throw e}finally{conn.release()}
});
app.post("/api/admin/campaigns/:id/draw",admin,async(q,r)=>{
  const conn=await db.getConnection();
  try{
    await conn.beginTransaction();
    const [[campaign]]=await conn.execute("SELECT id,title,status FROM campaigns WHERE id=? FOR UPDATE",[q.params.id]);
    if(!campaign){await conn.rollback();return r.status(404).json({error:"کمپین پیدا نشد."})}
    if(!["closed","paused"].includes(campaign.status)){await conn.rollback();return r.status(409).json({error:"برای قرعه‌کشی ابتدا کمپین را ببندید یا متوقف کنید."})}
    const [[already]]=await conn.execute("SELECT id FROM campaign_draws WHERE campaign_id=? LIMIT 1",[campaign.id]);
    if(already){await conn.rollback();return r.status(409).json({error:"قرعه‌کشی این کمپین قبلاً انجام شده است."})}
    const [[pending]]=await conn.execute("SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status='pending_payment'",[campaign.id]);
    if(Number(pending.total)){await conn.rollback();return r.status(409).json({error:"ابتدا پرداخت‌های معلق را تعیین تکلیف کنید."})}
    const [people]=await conn.execute(
      `SELECT e.id,pt.full_name,pt.instagram,ic.code
       FROM campaign_entries e
       JOIN participants pt ON pt.id=e.participant_id
       JOIN issued_codes ic ON ic.entry_id=e.id AND ic.campaign_id=e.campaign_id AND ic.status='active'
       WHERE e.campaign_id=? AND e.status='active' AND e.payment_status IN ('not_required','approved')
       ORDER BY e.id FOR UPDATE`,[campaign.id]
    );
    if(!people.length){await conn.rollback();return r.status(400).json({error:"شرکت‌کننده واجد شرایطی در این کمپین وجود ندارد."})}
    const winner=people[crypto.randomInt(people.length)];
    const seed=crypto.randomBytes(32).toString("hex");
    const [draw]=await conn.execute("INSERT INTO campaign_draws(campaign_id,winner_entry_id,winner_code,drawn_by,draw_seed) VALUES(?,?,?,?,?)",[campaign.id,winner.id,winner.code,String(process.env.ADMIN_ID),seed]);
    for(const person of people)await conn.execute("INSERT INTO campaign_draw_participants(draw_id,entry_id,code) VALUES(?,?,?)",[draw.insertId,person.id,person.code]);
    await conn.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",[String(process.env.ADMIN_ID),"campaign_draw","campaign",String(campaign.id),JSON.stringify({draw_id:draw.insertId,eligible_count:people.length,winner_entry_id:winner.id})]);
    await conn.commit();
    r.json({drawId:draw.insertId,total:people.length,winner:{name:winner.full_name,instagram:winner.instagram,code:winner.code}});
  }catch(e){await conn.rollback();console.error("Campaign draw error:",e.message);r.status(500).json({error:"قرعه‌کشی کمپین انجام نشد."})}
  finally{conn.release()}
});
app.get("/api/admin/campaign-payments",admin,async(_q,r)=>{
  const [rows]=await db.query(`
    SELECT p.id AS payment_id,p.entry_id,p.mode,p.status,p.amount_minor,p.currency,p.created_at,
           e.campaign_id,c.title AS campaign_title,pt.full_name,pt.phone,pt.instagram
    FROM campaign_payments p
    JOIN campaign_entries e ON e.id=p.entry_id
    JOIN campaigns c ON c.id=e.campaign_id
    JOIN participants pt ON pt.id=e.participant_id
    WHERE p.status='pending' ORDER BY p.id ASC LIMIT 200
  `);
  r.json({payments:rows});
});
app.post("/api/admin/campaign-payments/:id/approve",admin,async(q,r)=>{
  if(!process.env.CAMPAIGN_CODE_SECRET||process.env.CAMPAIGN_CODE_SECRET.length<32)
    return r.status(503).json({error:"کلید امن صدور کد روی سرور تنظیم نشده است."});
  try{
    const result=await approveManualPayment({db,paymentId:q.params.id,reviewer:String(process.env.ADMIN_ID),codeSecret:process.env.CAMPAIGN_CODE_SECRET});
    await audit(process.env.ADMIN_ID,"approve_campaign_payment","campaign_payment",q.params.id,{entry_id:result.entryId,code:result.code});
    r.json(result);
  }catch(e){
    if(["PAYMENT_NOT_REVIEWABLE","CAMPAIGN_NOT_OPEN","CAMPAIGN_FULL"].includes(e.code))
      return r.status(409).json({error:e.code==="CAMPAIGN_FULL"?"ظرفیت کمپین تکمیل شده است.":e.code==="CAMPAIGN_NOT_OPEN"?"کمپین فعال نیست.":"این پرداخت قابل بررسی نیست."});
    throw e;
  }
});
app.get("/api/admin/stats",admin,async(_q,r)=>{const [[a]]=await db.query("SELECT COUNT(*) total FROM lottery_entries WHERE status='active'");const [[b]]=await db.query("SELECT COUNT(*) total FROM lottery_entries WHERE status='active' AND DATE(created_at)=CURDATE()");const [[c]]=await db.query("SELECT COUNT(*) total FROM lottery_sessions");const [[d]]=await db.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed'");const [[f]]=await db.execute("SELECT COUNT(*) total FROM webhook_inbox WHERE status='failed'");r.json({total:a.total,today:b.total,pending:c.total,failedUpdates:f.total,open:await registrationOpen(),drawn:d?.setting_value==='true'})});
app.get("/api/admin/entries",admin,async(q,r)=>{const term=String(q.query.q||"").slice(0,100),like="%"+term+"%",limit=Math.min(100,Math.max(1,Number(q.query.limit)||50)),offset=Math.min(1000000,Math.max(0,Number(q.query.offset)||0));const [rows]=await db.execute(`SELECT id,full_name,phone,instagram,raffle_code,status,created_at FROM lottery_entries WHERE status<>'deleted' AND (?='' OR full_name LIKE ? OR phone LIKE ? OR instagram LIKE ? OR raffle_code LIKE ?) ORDER BY created_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`,[term,like,like,like,like]);r.json({entries:rows,limit,offset})});
async function audit(adminId,action,type,id,details={}){await db.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",[String(adminId),action,type,String(id),JSON.stringify(details)])}
app.get("/api/admin/entries/:id",admin,async(q,r)=>{const [rows]=await db.execute("SELECT id,telegram_user_id,chat_id,full_name,phone,instagram,raffle_code,status,created_at,updated_at,deleted_at,deletion_reason FROM lottery_entries WHERE id=? LIMIT 1",[q.params.id]);if(!rows.length)return r.status(404).json({error:"شرکت‌کننده پیدا نشد."});r.json({entry:rows[0]})});
app.post("/api/admin/entries/:id/status",admin,async(q,r)=>{const status=q.body.status;if(!["active","inactive"].includes(status))return r.status(400).json({error:"وضعیت نامعتبر است."});if(status==="active"){const [dups]=await db.execute("SELECT e.id FROM lottery_entries e JOIN lottery_entries x ON (x.phone=e.phone OR LOWER(x.instagram)=LOWER(e.instagram)) AND x.id<>e.id AND x.status='active' WHERE e.id=? LIMIT 1",[q.params.id]);if(dups.length)return r.status(409).json({error:"شماره یا آیدی این شرکت‌کننده با فرد فعال دیگری تکراری است."})}const [result]=await db.execute("UPDATE lottery_entries SET status=? WHERE id=? AND status<>'deleted'",[status,q.params.id]);if(!result.affectedRows)return r.status(404).json({error:"شرکت‌کننده پیدا نشد یا حذف شده است."});await audit("admin",status==="active"?"restore_entry":"deactivate_entry","lottery_entry",q.params.id);r.json({ok:true,status})});
app.put("/api/admin/entries/:id",admin,async(q,r)=>{const fullName=String(q.body.full_name||"").trim(),phone=normalizePhone(q.body.phone||""),instagram=normalizeInstagram(q.body.instagram||"");if(!validFullName(fullName)||!validPhone(phone)||!validInstagram(instagram))return r.status(400).json({error:"اطلاعات واردشده معتبر نیست."});const [dup]=await db.execute("SELECT id FROM lottery_entries WHERE status='active' AND id<>? AND (phone=? OR LOWER(instagram)=LOWER(?)) LIMIT 1",[q.params.id,phone,instagram]);if(dup.length)return r.status(409).json({error:"این شماره یا آیدی اینستاگرام برای شرکت‌کننده دیگری ثبت شده است."});const [result]=await db.execute("UPDATE lottery_entries SET full_name=?,phone=?,instagram=? WHERE id=? AND status<>'deleted'",[fullName,phone,instagram,q.params.id]);if(!result.affectedRows)return r.status(404).json({error:"شرکت‌کننده پیدا نشد."});await audit("admin","edit_entry","lottery_entry",q.params.id,{full_name:fullName,phone,instagram});r.json({ok:true})});
app.post("/api/admin/entries/:id/delete",admin,async(q,r)=>{
const reason=String(q.body.reason||"حذف توسط مدیر").slice(0,255);
const conn=await db.getConnection();
try{
await conn.beginTransaction();
const [rows]=await conn.execute("SELECT id,status,raffle_code FROM lottery_entries WHERE id=? FOR UPDATE",[q.params.id]);
if(!rows.length){await conn.rollback();return r.status(404).json({error:"شرکت‌کننده پیدا نشد."})}
if(rows[0].status==="deleted"){await conn.rollback();return r.status(409).json({error:"این شرکت‌کننده قبلاً حذف شده است."})}
await conn.execute("UPDATE lottery_entries SET status='deleted',deleted_at=NOW(),deletion_reason=? WHERE id=?",[reason,q.params.id]);
await conn.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",[String(process.env.ADMIN_ID||"admin"),"delete_entry","lottery_entry",String(q.params.id),JSON.stringify({reason,raffle_code:rows[0].raffle_code})]);
await conn.commit();
r.json({ok:true,status:"deleted",raffle_code:rows[0].raffle_code});
}catch(e){
await conn.rollback();
console.error("Delete entry error:",e.message);
r.status(500).json({error:"حذف شرکت‌کننده انجام نشد."});
}finally{conn.release()}
});
app.get("/api/admin/entries/:id/code-history",admin,async(q,r)=>{const [rows]=await db.execute("SELECT raffle_code,action,actor,created_at FROM lottery_code_history WHERE entry_id=? ORDER BY id DESC LIMIT 100",[q.params.id]);r.json({history:rows})});
app.get("/api/admin/audit",admin,async(q,r)=>{const limit=Math.min(100,Math.max(1,Number(q.query.limit)||50));const [rows]=await db.query(`SELECT id,admin_id,action,entity_type,entity_id,details,created_at FROM admin_audit_log ORDER BY id DESC LIMIT ${limit}`);r.json({events:rows})});
app.get("/api/admin/export.csv",admin,async(_q,r)=>{const [rows]=await db.query("SELECT full_name,phone,instagram,raffle_code,created_at FROM lottery_entries WHERE status='active' ORDER BY created_at DESC");const cell=csvCell;const csv="\uFEFF"+[["نام","موبایل","اینستاگرام","کد","زمان"].map(cell).join(","),...rows.map(x=>[x.full_name,x.phone,"@"+x.instagram,x.raffle_code,x.created_at].map(cell).join(","))].join("\r\n");r.setHeader("Content-Type","text/csv; charset=utf-8");r.setHeader("Content-Disposition",'attachment; filename="istore-lottery.csv"');r.send(csv)});
app.post("/api/admin/registration",admin,async(q,r)=>{
const v=q.body.open===true?"true":"false";
const conn=await db.getConnection();
try{
await conn.beginTransaction();
await conn.execute("INSERT IGNORE INTO lottery_settings(setting_key,setting_value) VALUES('registration_open','false'),('draw_completed','false')");
const [[registrationState]]=await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='registration_open' FOR UPDATE");
const [[drawState]]=await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed' FOR UPDATE");
if(v==="true"&&drawState?.setting_value==="true"){
await conn.rollback();
return r.status(409).json({error:"قرعه‌کشی این دوره انجام شده؛ برای شروع دوره جدید باید فرآیند کمپین جدید تعریف شود."});
}
await conn.execute("UPDATE lottery_settings SET setting_value=? WHERE setting_key='registration_open'",[v]);
await conn.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",[String(process.env.ADMIN_ID),v==="true"?"open_registration":"close_registration","lottery","current",JSON.stringify({previous:registrationState?.setting_value||"false",next:v})]);
await conn.commit();
r.json({open:v==="true"});
}catch(e){
await conn.rollback();
console.error("Registration setting error:",e.message);
r.status(500).json({error:"تغییر وضعیت ثبت‌نام انجام نشد."});
}finally{conn.release()}
});
app.post("/api/admin/draw",admin,async(_q,r)=>{if(await registrationOpen())return r.status(409).json({error:"ابتدا ثبت‌نام را ببندید، سپس قرعه‌کشی کنید."});const conn=await db.getConnection();try{await conn.beginTransaction();
const [[registrationState]]=await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='registration_open' FOR UPDATE");
if(registrationState?.setting_value==='true'){await conn.rollback();return r.status(409).json({error:"ابتدا ثبت‌نام را ببندید، سپس قرعه‌کشی کنید."})}
await conn.execute("INSERT IGNORE INTO lottery_settings(setting_key,setting_value) VALUES('draw_completed','false')");
const [[lock]]=await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='draw_completed' FOR UPDATE");
if(lock.setting_value==='true'){await conn.rollback();return r.status(409).json({error:"قرعه‌کشی قبلاً انجام شده است."})}
const [rows]=await conn.query("SELECT id,full_name,instagram,raffle_code FROM lottery_entries WHERE status='active' ORDER BY id FOR UPDATE");
if(!rows.length){await conn.rollback();return r.status(400).json({error:"شرکت‌کننده واجد شرایطی وجود ندارد."})}
const winner=rows[crypto.randomInt(rows.length)],seed=crypto.randomBytes(32).toString("hex");
const [draw]=await conn.execute("INSERT INTO lottery_draws(winner_entry_id,winner_code,drawn_by,draw_seed) VALUES(?,?,?,?)",[winner.id,winner.raffle_code,String(process.env.ADMIN_ID||"admin"),seed]);
for(const row of rows)await conn.execute("INSERT INTO lottery_draw_participants(draw_id,entry_id,raffle_code) VALUES(?,?,?)",[draw.insertId,row.id,row.raffle_code]);
await conn.execute("UPDATE lottery_settings SET setting_value='true' WHERE setting_key='draw_completed'");
await conn.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",[String(process.env.ADMIN_ID||"admin"),"draw","lottery_draw",String(draw.insertId),JSON.stringify({eligible_count:rows.length,winner_entry_id:winner.id})]);
await conn.commit();r.json({total:rows.length,winner:{name:winner.full_name,instagram:winner.instagram,code:winner.raffle_code}})
}catch(e){await conn.rollback();console.error("Draw error:",e.message);r.status(500).json({error:"اجرای قرعه‌کشی ناموفق بود."})}finally{conn.release()}});
const {createNotificationOutbox}=require("./notification-outbox");
const notificationOutbox=createNotificationOutbox({db,send:(method,payload)=>tg(method,payload),logger:console});
const {createWebhookQueue}=require("./webhook-queue");
const webhookQueue=createWebhookQueue({
db,
handlers:{business:handleUpdate,private:handlePrivateUpdate,callback:handleCallbackQuery},
logger:console
});
app.post("/telegram/"+secret,async(q,r)=>{
if(q.get("x-telegram-bot-api-secret-token")!==secret)return r.status(401).send("Unauthorized");
const u=q.body||{};
if(!Number.isSafeInteger(Number(u.update_id)))return r.status(400).send("Invalid update");
try{
await db.execute("INSERT INTO webhook_inbox(update_id,payload,status) VALUES(?,?,'pending')",[String(u.update_id),JSON.stringify(u)]);
return r.sendStatus(200);
}catch(e){
if(e.code==="ER_DUP_ENTRY")return r.sendStatus(200);
console.error("Webhook enqueue error:",e.message);
return r.sendStatus(503);
}
});
app.use(createErrorMiddleware(console));
const server=app.listen(+(process.env.PORT||3000),async()=>{
try{
await db.query("SELECT 1");
console.log("iStore lottery bot started");
}catch(e){
console.error("DB connection failed:",e.message);
server.close(()=>process.exit(1));
}
});
webhookQueue.start();
notificationOutbox.start();
let shuttingDown=false;
async function shutdown(signal){
if(shuttingDown)return;
shuttingDown=true;
console.log(signal+" received; draining webhook queue (30s limit)");
const forceExit=setTimeout(()=>{
console.error("Shutdown deadline exceeded; forcing process exit. Any unfinished webhook will be reclaimed by its lease.");
process.exit(1);
},35000);
const drained=await webhookQueue.stop(30000);
const notificationsDrained=await notificationOutbox.stop(30000);
if(!drained)console.error("Webhook queue did not drain within 30 seconds; exiting so the unfinished lease can be reclaimed.");
if(!notificationsDrained)console.error("Notification outbox did not drain within 30 seconds; unfinished notifications remain leased for recovery.");
server.close(()=>{db.end().finally(()=>{clearTimeout(forceExit);process.exit(drained?0:1)})});
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));
