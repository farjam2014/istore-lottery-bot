require("dotenv").config();
const express=require("express"), mysql=require("mysql2/promise"), crypto=require("crypto"), path=require("path");
for(const k of ["BOT_TOKEN","WEBHOOK_SECRET","ADMIN_PASSWORD","SESSION_SECRET","ADMIN_ID","DB_HOST","DB_NAME","DB_USER","DB_PASSWORD"]){if(!process.env[k]){console.error("Missing env:",k);process.exit(1)}}
const {normalizePhone,validPhone,normalizeInstagram,validInstagram,validFullName,makeRaffleCode}=require("./domain");
const {createAdminTelegram}=require("./admin-telegram");
const {createCampaignService}=require("./campaign-service");
const {createBankCardService}=require("./bank-card-service");
const {createDrawService}=require("./draw-service");
const app=express();
const {patchAsyncRoutes,createErrorMiddleware}=require("./async-route");
patchAsyncRoutes(app);
app.disable("x-powered-by");
app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","same-origin");res.setHeader("X-Frame-Options","DENY");res.setHeader("Cache-Control","no-store");next()});
app.use(express.json({limit:"256kb"})); app.use(express.urlencoded({extended:false,limit:"16kb"}));
const { createSameOriginGuard } = require("./security");
app.use(createSameOriginGuard());
app.use(express.static(path.join(__dirname,"..","public"),{index:false}));
const db=mysql.createPool({host:process.env.DB_HOST,port:+(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,connectionLimit:8,waitForConnections:true,queueLimit:100,connectTimeout:10000,enableKeepAlive:true,keepAliveInitialDelay:0,charset:"utf8mb4"});
const campaignService=createCampaignService({db,adminId:process.env.ADMIN_ID});
const bankCardService=createBankCardService({db,adminId:process.env.ADMIN_ID});
const drawService=createDrawService({db,adminId:process.env.ADMIN_ID});
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
if(payload&&typeof payload==="object"&&payload.business_connection_id===""){payload={...payload};delete payload.business_connection_id;}
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
async function reply(chat,connection,text,extra={}){const payload={chat_id:chat,text,...extra};if(connection)payload.business_connection_id=connection;return tg("sendMessage",payload)}
function storeReturnButton(){const url=String(process.env.STORE_TELEGRAM_URL||"").trim();return /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/?$/.test(url)?{text:"↩️ بازگشت به پی‌وی فروشگاه",url}:null}
function registrationKeyboard(){const rows=[[{text:"▶️ ادامه ثبت‌نام",callback_data:"reg:continue"}]];const back=storeReturnButton();if(back)rows.push([back]);rows.push([{text:"لغو ثبت‌نام",callback_data:"reg:cancel"}]);return {inline_keyboard:rows}}
const adminTelegram=createAdminTelegram({db,tg,tgDocument,adminId:process.env.ADMIN_ID,registrationOpen,campaignService,bankCardService});
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
async function putSession(uid,chat,step,name,phone,conn,instagram=null){await db.execute(`INSERT INTO lottery_sessions(telegram_user_id,chat_id,step,full_name,phone,instagram,business_connection_id) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id),step=VALUES(step),full_name=VALUES(full_name),phone=VALUES(phone),instagram=VALUES(instagram),business_connection_id=VALUES(business_connection_id)`,[String(uid),String(chat),step,name,phone,instagram,conn])}
async function delSession(uid){await db.execute("DELETE FROM lottery_sessions WHERE telegram_user_id=?",[String(uid)])}
async function saveEntry(uid,chat,name,phone,inst,businessConnection){
const conn=await db.getConnection();
try{
await conn.beginTransaction();
const [[registrationState]]=await conn.execute("SELECT setting_value FROM lottery_settings WHERE setting_key='registration_open' FOR UPDATE");
const legacyRegistrationOpen=registrationState?.setting_value==="true";
const [[openCampaign]]=await conn.execute("SELECT id FROM campaigns WHERE status='open' AND slug<>'legacy-lottery' LIMIT 1");
if(openCampaign){
  const [[existingParticipant]]=await conn.execute("SELECT id,status FROM participants WHERE telegram_user_id=? FOR UPDATE",[String(uid)]);
  if(existingParticipant){
    if(existingParticipant.status!=="active")throw new Error("پروفایل شما غیرفعال است؛ با پشتیبانی تماس بگیرید.");
    await conn.execute("UPDATE participants SET chat_id=?,business_connection_id=? WHERE id=?",[String(chat),businessConnection||null,existingParticipant.id]);
    await conn.commit();
    return null;
  }
  const [duplicates]=await conn.execute("SELECT id FROM participants WHERE status='active' AND (phone=? OR LOWER(instagram)=LOWER(?)) AND telegram_user_id<>? LIMIT 1",[phone,inst,String(uid)]);
  if(duplicates.length)throw Object.assign(new Error("DUPLICATE_CONTACT"),{code:"DUPLICATE_CONTACT"});
  await conn.execute("INSERT INTO participants(telegram_user_id,chat_id,business_connection_id,full_name,phone,instagram,status) VALUES(?,?,?,?,?,?,'active')",[String(uid),String(chat),businessConnection||null,name,phone,inst]);
  await conn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",["campaign-profile-admin:"+uid+":"+crypto.randomUUID(),"campaign_profile_created_admin",JSON.stringify({method:"sendMessage",payload:{chat_id:process.env.ADMIN_ID,text:"👤 پروفایل کمپین جدید ثبت شد.\nTelegram ID: "+uid+"\nنام: "+name+"\nموبایل: "+phone+"\nاینستاگرام: @"+inst}})]);
  await conn.commit();
  return null;
}
if(!legacyRegistrationOpen)throw Object.assign(new Error("REGISTRATION_CLOSED"),{code:"REGISTRATION_CLOSED"});
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
const [sameParticipant]=await db.execute("SELECT id,status FROM participants WHERE telegram_user_id=? LIMIT 1",[String(uid)]);
if(sameParticipant[0]?.status==="active")return null;
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

function campaignQuantityKeyboard(campaignId,max,page=0){
  const pageSize=80,totalPages=Math.max(1,Math.ceil(max/pageSize));
  const current=Math.max(0,Math.min(totalPages-1,Number(page)||0));
  const start=current*pageSize+1,end=Math.min(max,start+pageSize-1),rows=[];
  for(let n=start;n<=end;n+=4)rows.push(Array.from({length:Math.min(4,end-n+1)},(_,i)=>({text:String(n+i)+' کد',callback_data:'campaign:quantity:'+campaignId+':'+(n+i)})));
  const nav=[];
  if(current>0)nav.push({text:'⬅️ قبلی',callback_data:'campaign:quantity-page:'+campaignId+':'+(current-1)});
  if(current<totalPages-1)nav.push({text:'بعدی ➡️',callback_data:'campaign:quantity-page:'+campaignId+':'+(current+1)});
  if(nav.length)rows.push(nav);
  return {inline_keyboard:rows};
}

async function handleCallbackQuery(q){
if(!q?.id)return;
const uid=String(q.from?.id||"");
const chat=String(q.message?.chat?.id||"");
if(q.data==="reg:continue"||q.data==="reg:cancel"){
const s=await session(uid);
if(!uid||!s||String(s.chat_id)!==chat||String(s.business_connection_id)!==String(q.message?.business_connection_id||""))return tg("answerCallbackQuery",{callback_query_id:q.id,text:"این مرحله معتبر نیست یا منقضی شده است.",show_alert:true});
if(q.data==="reg:cancel"){await delSession(uid);await tg("answerCallbackQuery",{callback_query_id:q.id,text:"ثبت‌نام لغو شد."});return tg("sendMessage",{chat_id:chat,business_connection_id:s.business_connection_id,text:"ثبت‌نام لغو شد. هر زمان خواستید می‌توانید دوباره «لاتاری» را ارسال کنید."});}
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"ادامه ثبت‌نام"});
const prompts={name:"لطفاً نام و نام خانوادگی خود را به‌صورت دستی در همین گفتگو تایپ کنید.",instagram:"لطفاً آیدی اینستاگرام خود را ارسال کنید؛ مثال: @example",awaiting_contact:"برای ادامه، دکمه ارسال شماره موبایل را بزنید.",awaiting_confirmation:"برای تکمیل ثبت‌نام، دکمه تأیید را انتخاب کنید.",phone:"برای ادامه ثبت‌نام، شماره موبایل خود را از طریق ربات ارسال کنید."};
return tg("sendMessage",{chat_id:chat,business_connection_id:s.business_connection_id,text:prompts[s.step]||"لطفاً مرحله ثبت‌نام را ادامه دهید.",reply_markup:registrationKeyboard()});
}
if(q.data==="reg:confirm"){
const s=await session(uid),connection=String(q.message?.business_connection_id||"");
if(!uid||!s||s.step!=="awaiting_confirmation"||String(s.chat_id)!==chat||String(s.business_connection_id||"")!==connection){
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"این درخواست معتبر نیست یا قبلاً استفاده شده است.",show_alert:true});
}
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"در حال ثبت پروفایل..."});
try{
await saveEntry(uid,s.chat_id,s.full_name,s.phone,s.instagram,connection);
await delSession(uid);
return tg("sendMessage",{chat_id:chat,text:"✅ پروفایل شما با موفقیت ثبت شد. حالا می‌توانید کمپین موردنظرتان را انتخاب کنید.",reply_markup:{inline_keyboard:[[{text:"🧩 نمایش کمپین‌های فعال",callback_data:"campaign:list"}]]}});
}catch(e){
console.error("Campaign profile confirmation error:",e.message);
const msg=e.code==="DUPLICATE_CONTACT"?"❌ این شماره موبایل یا آیدی اینستاگرام قبلاً با حساب دیگری ثبت شده است.":e.code==="REGISTRATION_CLOSED"?"❌ در حال حاضر ثبت‌نام بسته است.":"❌ ثبت پروفایل انجام نشد. اطلاعات واردشده حفظ شده است؛ لطفاً دوباره تلاش کنید.";
return tg("sendMessage",{chat_id:chat,text:msg});
}
}
if(verifyConfirmationPayload(q.data||"",uid,chat,q.message?.business_connection_id||"")){
const s=await session(uid);
if(!uid||!s||s.step!=="awaiting_confirmation"||String(s.chat_id)!==chat||String(s.business_connection_id)!==String(q.message?.business_connection_id||"")){
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"این درخواست معتبر نیست یا قبلاً استفاده شده است.",show_alert:true});
}
if(!await registrationOpen()){
const [[campaignOpen]]=await db.execute("SELECT id FROM campaigns WHERE status='open' AND slug<>'legacy-lottery' LIMIT 1");
if(!campaignOpen){
await delSession(uid);
return tg("answerCallbackQuery",{callback_query_id:q.id,text:"مهلت ثبت‌نام به پایان رسیده است.",show_alert:true});
}
}
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"در حال ثبت نهایی..."});
try{
await saveEntry(uid,s.chat_id,s.full_name,s.phone,s.instagram,s.business_connection_id);
await delSession(uid);
return;
}catch(e){
console.error("Lottery confirmation error:",e.message);
const msg=e.code==="DUPLICATE_CONTACT"?"❌ این شماره موبایل یا آیدی اینستاگرام قبلاً با حساب دیگری ثبت شده است. برای بررسی با پشتیبانی تماس بگیرید.":e.code==="REGISTRATION_CLOSED"?"❌ مهلت ثبت‌نام به پایان رسیده است.":"❌ ثبت نهایی با خطا مواجه شد. اطلاعات شما حذف نشده است؛ لطفاً کمی بعد دوباره تلاش کنید.";
return tg("sendMessage",{chat_id:s.chat_id,business_connection_id:s.business_connection_id,text:msg});
}
}
if(String(q.data||'').startsWith('campaign:details:')){
  const campaignId=String(q.data.split(':')[2]||'');
  if(!uid||!chat||!/^[0-9]+$/.test(campaignId))return tg('answerCallbackQuery',{callback_query_id:q.id,text:'درخواست نامعتبر است.',show_alert:true});
  await tg('answerCallbackQuery',{callback_query_id:q.id});
  const [[campaign]]=await db.execute("SELECT id,name,description,payment_mode,price_per_code,currency,max_codes_per_participant FROM campaigns WHERE id=? AND status='open' AND slug<>'legacy-lottery' LIMIT 1",[campaignId]);
  if(!campaign)return reply(chat,String(q.message?.business_connection_id||''),'این کمپین دیگر فعال نیست.');
  const price=campaign.payment_mode==='free'?'رایگان':Number(campaign.price_per_code).toLocaleString('en-US')+' '+campaign.currency+' برای هر کد';
  const body='🧩 '+campaign.name+'\\n\\n'+(campaign.description||'توضیحات تکمیلی برای این کمپین ثبت نشده است.')+'\\n\\n💳 شیوه شرکت: '+price+'\\n🎟 حداکثر کد برای هر نفر: '+campaign.max_codes_per_participant+'\\n\\nبرای ادامه، دکمه زیر را بزنید.';
  return tg('sendMessage',{chat_id:chat,text:body,reply_markup:{inline_keyboard:[[{text:'▶️ شروع ثبت‌نام',callback_data:'campaign:join:'+campaign.id}],[{text:'↩️ بازگشت به کمپین‌ها',callback_data:'campaign:list'}]]}});
}
if(q.data==='campaign:list'){
  await tg('answerCallbackQuery',{callback_query_id:q.id});
  const [campaigns]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency FROM campaigns WHERE status='open' AND slug<>'legacy-lottery' ORDER BY id DESC LIMIT 20");
  const buttons=campaigns.map(c=>[{text:c.name+' · '+(c.payment_mode==='free'?'رایگان':c.price_per_code+' '+c.currency),callback_data:'campaign:details:'+c.id}]);
  return tg('sendMessage',{chat_id:chat,text:campaigns.length?'🧩 کمپین فعال موردنظرتان را انتخاب کنید:':'در حال حاضر کمپین بازی برای ثبت‌نام وجود ندارد.',reply_markup:{inline_keyboard:buttons}});
}
if(String(q.data||'').startsWith('campaign:join:')){
  const uid=String(q.from?.id||''),chat=String(q.message?.chat?.id||''),connection=String(q.message?.business_connection_id||''),campaignId=String(q.data.split(':')[2]||'');
  if(!uid||!chat||!/^[0-9]+$/.test(campaignId))return tg('answerCallbackQuery',{callback_query_id:q.id,text:'درخواست نامعتبر است.',show_alert:true});
  await tg('answerCallbackQuery',{callback_query_id:q.id});
  try{
    const [[participant]]=await db.execute("SELECT * FROM participants WHERE telegram_user_id=? LIMIT 1",[uid]);
    if(participant&&participant.status!=='active')throw new Error('پروفایل شما غیرفعال است. برای بررسی با پشتیبانی تماس بگیرید.');
    if(!participant){
      await putSession(uid,chat,"name",null,null,connection);
      return reply(chat,connection,"برای شرکت در کمپین، ابتدا پروفایل دائمی خود را تکمیل کنید.\\n\\nنام و نام خانوادگی خود را ارسال کنید. این اطلاعات فقط یک‌بار دریافت می‌شود و برای کمپین‌های بعدی محفوظ می‌ماند.");
    }
    const [[campaign]]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency,max_codes_per_participant FROM campaigns WHERE id=? AND status='open' AND slug<>'legacy-lottery' LIMIT 1",[campaignId]);
    if(!campaign)throw new Error('این کمپین دیگر باز نیست.');
    const max=Math.max(1,Math.min(1000,Number(campaign.max_codes_per_participant)||1));
    await db.execute('UPDATE participants SET chat_id=?,business_connection_id=? WHERE id=?',[chat,connection,participant.id]);
    return tg('sendMessage',{chat_id:chat,text:'🎟 کمپین: '+campaign.name+'\\nحداکثر تعداد مجاز برای هر نفر: '+max+'\\n\\nچند کد می‌خواهید دریافت کنید؟',reply_markup:campaignQuantityKeyboard(campaign.id,max,0)});
  }catch(e){return reply(chat,connection,'❌ امکان ادامه ثبت‌نام وجود ندارد: '+e.message);}
}
if(String(q.data||'').startsWith('campaign:quantity-page:')){
  const parts=String(q.data).split(':'),campaignId=parts[3]||'',page=Number(parts[4]);
  if(!uid||!chat||!/^[0-9]+$/.test(campaignId)||!Number.isInteger(page)||page<0)return tg('answerCallbackQuery',{callback_query_id:q.id,text:'درخواست نامعتبر است.',show_alert:true});
  const [[campaign]]=await db.execute("SELECT id,max_codes_per_participant FROM campaigns WHERE id=? AND status='open' AND slug<>'legacy-lottery' LIMIT 1",[campaignId]);
  if(!campaign)return tg('answerCallbackQuery',{callback_query_id:q.id,text:'این کمپین دیگر فعال نیست.',show_alert:true});
  const max=Math.max(1,Math.min(1000,Number(campaign.max_codes_per_participant)||1)),totalPages=Math.ceil(max/80);
  if(page>=totalPages)return tg('answerCallbackQuery',{callback_query_id:q.id,text:'این صفحه معتبر نیست.',show_alert:true});
  await tg('answerCallbackQuery',{callback_query_id:q.id});
  return tg('editMessageReplyMarkup',{chat_id:chat,message_id:q.message.message_id,reply_markup:campaignQuantityKeyboard(campaign.id,max,page)});
}
if(String(q.data||'').startsWith('campaign:quantity:')){
  const uid=String(q.from?.id||''),chat=String(q.message?.chat?.id||''),connection=String(q.message?.business_connection_id||'');
  const parts=String(q.data).split(':'),campaignId=parts[2]||'',quantity=Number(parts[3]);
  if(!uid||!chat||!/^[0-9]+$/.test(campaignId)||!Number.isInteger(quantity)||quantity<1||quantity>1000)return tg('answerCallbackQuery',{callback_query_id:q.id,text:'تعداد انتخابی نامعتبر است.',show_alert:true});
  await tg('answerCallbackQuery',{callback_query_id:q.id,text:'در حال ثبت درخواست...'});
  try{
    const [[participant]]=await db.execute("SELECT * FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);
    if(!participant)throw new Error('پروفایل فعال پیدا نشد؛ دوباره کمپین را انتخاب کنید.');
    const [[campaign]]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency,max_codes_per_participant FROM campaigns WHERE id=? AND status='open' AND slug<>'legacy-lottery' LIMIT 1",[campaignId]);
    if(!campaign)throw new Error('این کمپین دیگر باز نیست.');
    if(quantity>Number(campaign.max_codes_per_participant))throw new Error('تعداد انتخابی از سقف مجاز کمپین بیشتر است.');
    await db.execute('UPDATE participants SET chat_id=?,business_connection_id=? WHERE id=?',[chat,connection,participant.id]);
    if(campaign.payment_mode==='free'){
      await campaignService.joinFreeCampaign({campaignId:Number(campaignId),telegramUserId:uid,chatId:chat,businessConnectionId:connection,fullName:participant.full_name,phone:participant.phone,instagram:participant.instagram,quantity});
      return reply(chat,connection,'🎉 درخواست عضویت شما در کمپین «'+campaign.name+'» با '+quantity+' کد ثبت شد. کدها در پیام جداگانه برایتان ارسال می‌شوند.');
    }
    if(campaign.payment_mode!=='manual')throw new Error('درگاه پرداخت این کمپین هنوز فعال نشده است.');
    const order=await campaignService.reserveManualOrder({campaignId:Number(campaignId),participantId:participant.id,quantity});
    const card=order.card;
    await db.execute('INSERT INTO campaign_payment_sessions(telegram_user_id,chat_id,business_connection_id,order_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id),business_connection_id=VALUES(business_connection_id),order_id=VALUES(order_id)',[uid,chat,connection,order.id]);
    const sent=await reply(chat,connection,'🧾 سفارش شما ثبت شد.\\nکمپین: '+campaign.name+'\\nتعداد کد: '+quantity+'\\nشماره سفارش: '+order.orderRef+'\\nمبلغ: '+order.total+' '+order.currency+'\\n\\nشماره کارت: '+card.card_number+'\\nبه نام: '+card.cardholder_name+'\\n\\nپس از پرداخت، تصویر رسید را همین‌جا ارسال کنید. مهلت رزرو ۳۰ دقیقه است.');
    if(sent){try{await bankCardService.recordDelivery({orderId:order.id,card});}catch(deliveryError){console.error('Payment card delivery audit failed for order '+order.id+':',deliveryError.message);}}
    return sent;
  }catch(e){return reply(chat,connection,'❌ امکان ثبت‌نام در این کمپین وجود ندارد: '+e.message);}
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
const searchPrompts={"admin:search:phone":["phone","شماره موبایل شرکت‌کننده را وارد کنید:"],"admin:search:instagram":["instagram","آیدی اینستاگرام را وارد کنید:"],"admin:search:code":["raffle_code","کد قرعه‌کشی را وارد کنید:"]};
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
const adminHandled=await adminTelegram.handleMessage(m);
if(adminHandled!==false)return adminHandled;
return handleUpdate({business_message:{...m,business_connection_id:""}});
}

async function handleUpdate(update){
const m=update.business_message;
if(!m?.from||!m.chat||m.from.is_bot||m.chat.type!=="private")return;
const uid=String(m.from.id),chat=String(m.chat.id),conn=String(m.business_connection_id||""),t=String(m.text||m.caption||'').trim(),lower=t.toLowerCase();
if(m.contact){
  const s=await session(uid);
  if(!s||s.step!=="awaiting_contact"||String(s.chat_id)!==chat||String(s.business_connection_id||"")!==conn)return reply(chat,conn,"درخواست ارسال شماره فعال نیست. برای شروع دوباره /start را بزنید.");
  if(!m.contact.user_id||String(m.contact.user_id)!==uid)return reply(chat,conn,"❌ فقط شماره متعلق به حساب تلگرام خودتان پذیرفته می‌شود.");
  const phone=normalizePhone(m.contact.phone_number||"");
  if(!validPhone(phone))return reply(chat,conn,"شماره دریافت‌شده معتبر نیست. لطفاً دوباره از دکمه اشتراک‌گذاری شماره استفاده کنید.");
  await putSession(uid,chat,"instagram",s.full_name,phone,conn);
  return reply(chat,conn,"✅ شماره موبایل تأیید شد.\\nحالا آیدی اینستاگرام خود را بفرستید؛ مثال: @example",{reply_markup:{remove_keyboard:true}});
}
if(m.photo?.length){
  const [[paymentSession]]=await db.execute('SELECT order_id FROM campaign_payment_sessions WHERE telegram_user_id=? AND chat_id=? AND business_connection_id=? LIMIT 1',[uid,chat,conn]);
  if(!paymentSession)return;
  try{
    const photo=m.photo[m.photo.length-1];
    await campaignService.submitReceipt({orderId:paymentSession.order_id,fileId:photo.file_id,fileUniqueId:photo.file_unique_id,trackingReference:m.caption||null});
    await db.execute('DELETE FROM campaign_payment_sessions WHERE telegram_user_id=?',[uid]);
    return reply(chat,conn,'✅ رسید شما دریافت شد و برای بررسی مدیر ارسال شد. پس از تأیید، کدهای قرعه‌کشی برایتان ارسال می‌شود.');
  }catch(e){return reply(chat,conn,'❌ رسید ثبت نشد: '+e.message+'\nاگر مهلت سفارش تمام شده باشد دوباره از فهرست کمپین‌ها اقدام کنید.');}
}
if(lower==='/account'||lower==='/profile'||lower==='حساب من'||lower==='پروفایل من'){
  const [[participant]]=await db.execute("SELECT id,full_name,phone,instagram,status FROM participants WHERE telegram_user_id=? LIMIT 1",[uid]);
  if(!participant)return reply(chat,conn,"هنوز پروفایلی ندارید. برای شروع، /campaigns را بزنید و یک کمپین را انتخاب کنید.");
  const [entries]=await db.execute("SELECT c.name,ce.status,GROUP_CONCAT(cc.code ORDER BY cc.id SEPARATOR ', ') AS codes FROM campaign_entries ce JOIN campaigns c ON c.id=ce.campaign_id LEFT JOIN campaign_codes cc ON cc.entry_id=ce.id AND cc.status='active' WHERE ce.participant_id=? GROUP BY ce.id,c.name,ce.status ORDER BY ce.created_at DESC LIMIT 20",[participant.id]);
  const [orders]=await db.execute("SELECT o.order_ref,c.name,o.quantity,o.total_snapshot,o.currency,o.status FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id WHERE o.participant_id=? ORDER BY o.created_at DESC LIMIT 10",[participant.id]);
  const statusLabel={pending_payment:'در انتظار پرداخت',receipt_submitted:'رسید ارسال‌شده',approved:'تأییدشده',rejected:'ردشده',expired:'منقضی',cancelled:'لغوشده'};
  const entryText=entries.length?entries.map((x,i)=>(i+1)+') '+x.name+' · '+x.status+'\\nکدها: '+(x.codes||'هنوز صادر نشده')).join('\\n\\n'):'هنوز در کمپینی ثبت‌نام نکرده‌اید.';
  const orderText=orders.length?orders.map((x,i)=>(i+1)+') '+x.name+' · سفارش '+x.order_ref+'\\nتعداد: '+x.quantity+' · مبلغ: '+x.total_snapshot+' '+x.currency+'\\nوضعیت: '+(statusLabel[x.status]||x.status)).join('\\n\\n'):'سفارشی ندارید.';
  return reply(chat,conn,'👤 پروفایل شما\\nنام: '+participant.full_name+'\\nموبایل: '+participant.phone+'\\nاینستاگرام: @'+participant.instagram+'\\nوضعیت: '+participant.status+'\\n\\n🎟 کمپین‌ها و کدهای شما\\n'+entryText+'\\n\\n💳 سفارش‌ها\\n'+orderText,{reply_markup:{inline_keyboard:[[{text:'🧩 کمپین‌های فعال',callback_data:'campaign:list'}]]}});
}
if(lower==='/start'||lower==='لاتاری'||lower==='کمپین‌ها'||lower==='کمپین ها'||lower==='/campaigns'){
  const [campaigns]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency FROM campaigns WHERE status='open' AND slug<>'legacy-lottery' ORDER BY id DESC LIMIT 20");
  if(!campaigns.length)return reply(chat,conn,'در حال حاضر کمپین بازی برای ثبت‌نام وجود ندارد.');
  const buttons=campaigns.map(c=>[{text:c.name+' · '+(c.payment_mode==='free'?'رایگان':c.price_per_code+' '+c.currency),callback_data:'campaign:details:'+c.id}]);
  return tg('sendMessage',{chat_id:chat,business_connection_id:conn,text:'🧩 کمپین فعال موردنظرتان را انتخاب کنید:',reply_markup:{inline_keyboard:buttons}});
}

const profileChangeMatch=t.match(/^اصلاح\s+(نام|موبایل|اینستاگرام)\s*[:：]\s*(.+)$/);
if(profileChangeMatch){
  const fieldMap={'نام':'full_name','موبایل':'phone','اینستاگرام':'instagram'};
  try{
    const [[participant]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);
    if(!participant)return reply(chat,conn,'پروفایل کمپین شما پیدا نشد. ابتدا «لاتاری» را تکمیل کنید و دوباره تلاش کنید.');
    const request=await campaignService.requestProfileChange({participantId:participant.id,field:fieldMap[profileChangeMatch[1]],value:profileChangeMatch[2].trim()});
    return reply(chat,conn,'📝 درخواست اصلاح اطلاعات ثبت شد. پس از بررسی مدیر نتیجه اعلام می‌شود.\nشناسه درخواست: '+request.id);
  }catch(e){return reply(chat,conn,'❌ درخواست اصلاح ثبت نشد: '+e.message);}
}

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
if(lower==="لاتاری"||lower==="/start"){const legacyOpen=await registrationOpen();const [[campaignOpen]]=await db.execute("SELECT id FROM campaigns WHERE status='open' AND slug<>'legacy-lottery' LIMIT 1");if(!legacyOpen&&!campaignOpen)return reply(chat,conn,"ثبت‌نام فعلاً بسته است.");const old=await entry(uid);if(old&&old.status==="active")return reply(chat,conn,"شما قبلاً ثبت‌نام کرده‌اید.\nکد شما: "+old.raffle_code);await putSession(uid,chat,"name",null,null,conn);if(!legacyOpen)return reply(chat,conn,"🎉 برای شرکت در کمپین‌های فعال، ابتدا پروفایل خود را تکمیل کنید.\n\nنام و نام خانوادگی خود را وارد کنید؛ سپس شماره موبایل خودتان را با دکمه رسمی تلگرام تأیید می‌کنید.\nپس از ثبت پروفایل، با ارسال «کمپین‌ها» می‌توانید کمپین موردنظر را انتخاب کنید.",{reply_markup:registrationKeyboard()});return reply(chat,conn,"🎉 به قرعه‌کشی iStore خوش آمدید\n\nبرای شرکت در قرعه‌کشی، ابتدا صفحه زیر را در اینستاگرام دنبال کنید:\n\n📸 @ali_mhdizadeh_\n🔗 https://instagram.com/ali_mhdizadeh_\n\n⚠️ فالو کردن صفحه باید پیش از شروع ثبت‌نام در این ربات انجام شده باشد. افرادی که پس از ثبت‌نام صفحه را دنبال کنند، واجد شرایط شرکت در قرعه‌کشی نخواهند بود.\n\nنام و نام خانوادگی خود را به‌صورت دستی در همین گفتگو وارد کنید؛ اطلاعات پروفایل تلگرام شما دریافت نمی‌شود.\n\nبرای لغو ثبت‌نام از دکمه زیر استفاده کنید.",{reply_markup:registrationKeyboard()})}
const s=await session(uid);if(!s){if(t!=="لغو")return reply(chat,conn,"مرحله قبلی ثبت‌نام منقضی شده است. برای شروع دوباره کلمه «لاتاری» را ارسال کنید.");return}if(String(s.chat_id)!==chat)return;if(!await registrationOpen()){const [[campaignOpen]]=await db.execute("SELECT id FROM campaigns WHERE status='open' AND slug<>'legacy-lottery' LIMIT 1");if(!campaignOpen){await delSession(uid);return reply(chat,conn,"ثبت‌نام فعلاً بسته است.");}}
if(s.step==="name"){if(!validFullName(t))return reply(chat,conn,"لطفاً نام و نام خانوادگی معتبر وارد کنید.");const fullName=t.trim().replace(/\s+/g," ");await putSession(uid,chat,"awaiting_contact",fullName,null,conn);return reply(chat,conn,"✅ نام ثبت شد. حالا دکمه زیر را بزنید تا شماره موبایل متعلق به حساب خودتان را مستقیماً در همین ربات به اشتراک بگذارید.",{reply_markup:{keyboard:[[{text:"📱 اشتراک‌گذاری شماره من",request_contact:true}]],resize_keyboard:true,one_time_keyboard:true}})}
if(s.step==="phone"){await putSession(uid,chat,"awaiting_contact",s.full_name,null,conn,s.instagram||null);const link="https://t.me/istorelotterybot?start="+makeContactPayload(uid);return tg("sendMessage",{chat_id:chat,business_connection_id:conn,text:"برای امنیت ثبت‌نام، شماره‌ای که قبلاً به‌صورت متنی وارد می‌شد پذیرفته نیست. لطفاً شماره متعلق به خودتان را از طریق دکمه زیر و در ربات ارسال کنید.",reply_markup:{inline_keyboard:[[{text:"📱 تأیید شماره موبایل",url:link}]]}})}
if(s.step==="awaiting_confirmation"){
return tg("sendMessage",{chat_id:chat,business_connection_id:conn,text:"برای تکمیل ثبت‌نام، دکمه تأیید زیر را بزنید.",reply_markup:{inline_keyboard:[[{text:"ادامه ثبت‌نام",callback_data:makeConfirmationPayload(uid,chat,conn)}]]}});
}
if(s.step==="instagram"){
const inst=normalizeInstagram(t);
if(!validInstagram(inst))return reply(chat,conn,"آیدی نامعتبر است؛ فقط حروف انگلیسی، عدد، نقطه و زیرخط مجاز است.");
await putSession(uid,chat,"awaiting_confirmation",s.full_name,s.phone,conn,inst);
return tg("sendMessage",{chat_id:chat,text:"🔎 لطفاً اطلاعات پروفایل خود را بررسی و تأیید کنید:\\n\\nنام: "+s.full_name+"\\nموبایل: "+s.phone+"\\nاینستاگرام: @"+inst+"\\n\\nبا تأیید، پروفایل دائمی شما ساخته می‌شود.",reply_markup:{inline_keyboard:[[{text:"✅ تأیید و ساخت پروفایل",callback_data:"reg:confirm"}],[{text:"لغو",callback_data:"reg:cancel"}]]}});
}
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
const [rows]=await db.query("SELECT id,slug,name,status,payment_mode,price_per_code,currency,max_participants,max_codes,max_codes_per_participant,draw_basis,winner_count,alternate_count,draw_method,starts_at,ends_at,created_at FROM campaigns ORDER BY id DESC LIMIT 200");
r.json({campaigns:rows});
});
app.post("/api/admin/campaigns",admin,async(q,r)=>{
try{const result=await campaignService.createCampaign(q.body||{});r.status(201).json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.post("/api/admin/campaigns/:id/status",admin,async(q,r)=>{
if(!/^\\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه کمپین نامعتبر است."});
try{const result=await campaignService.setCampaignStatus(Number(q.params.id),String(q.body.status||""),String(q.body.reason||""));await audit("admin","campaign_status","campaign",q.params.id,{status:result.status,reason:q.body.reason||""});r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.get("/api/admin/payment-orders",admin,async(q,r)=>{
const status=String(q.query.status||"receipt_submitted");
if(!["pending_payment","receipt_submitted","approved","rejected","expired","cancelled"].includes(status))return r.status(400).json({error:"فیلتر وضعیت نامعتبر است."});
const [rows]=await db.execute("SELECT o.id,o.order_ref,o.campaign_id,c.name AS campaign_name,o.participant_id,p.full_name,p.phone,o.quantity,o.total_snapshot,o.currency,o.status,o.expires_at,o.created_at FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id JOIN participants p ON p.id=o.participant_id WHERE o.status=? ORDER BY o.created_at ASC LIMIT 200",[status]);
r.json({orders:rows});
});
app.post("/api/admin/payment-orders/:id/review",admin,async(q,r)=>{
if(!/^\\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه سفارش نامعتبر است."});
try{const result=await campaignService.reviewManualPayment({orderId:Number(q.params.id),approve:q.body.approve===true,trackingReference:q.body.tracking_reference||null,note:q.body.note||""});r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.post("/api/admin/campaigns/:id/draws/prepare",admin,async(q,r)=>{
if(!/^\\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه کمپین نامعتبر است."});
try{const result=await drawService.prepareDraw(Number(q.params.id));r.status(201).json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.get("/api/admin/draws/:id/candidates",admin,async(q,r)=>{
if(!/^\\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه قرعه‌کشی نامعتبر است."});
const [[draw]]=await db.execute("SELECT id,campaign_id,method,status,draw_basis,snapshot_hash,winner_count,alternate_count FROM campaign_draws WHERE id=? LIMIT 1",[q.params.id]);
if(!draw)return r.status(404).json({error:"قرعه‌کشی پیدا نشد."});
const [candidates]=await db.execute("SELECT candidate_reference,participant_id,code FROM draw_candidates WHERE draw_id=? AND eligibility='eligible' ORDER BY candidate_reference",[q.params.id]);
r.json({draw,candidates});
});
app.post("/api/admin/draws/:id/run",admin,async(q,r)=>{
if(!/^\\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه قرعه‌کشی نامعتبر است."});
try{const result=await drawService.runSystemDraw(Number(q.params.id));r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.post("/api/admin/draws/:id/live-results",admin,async(q,r)=>{
if(!/^\\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه قرعه‌کشی نامعتبر است."});
try{const result=await drawService.submitLiveWheelResults({drawId:Number(q.params.id),candidateReferences:q.body.candidate_references,externalReference:q.body.external_reference,evidenceHash:q.body.evidence_hash});r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.post("/api/admin/draws/:id/approve",admin,async(q,r)=>{
if(!/^\\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه قرعه‌کشی نامعتبر است."});
try{const result=await drawService.approveDraw(Number(q.params.id));r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.get("/api/admin/profile-change-requests",admin,async(q,r)=>{
const status=String(q.query.status||"pending");
if(!["pending","approved","rejected","cancelled"].includes(status))return r.status(400).json({error:"وضعیت درخواست نامعتبر است."});
const [rows]=await db.execute("SELECT r.id,r.participant_id,p.telegram_user_id,p.full_name,r.field_name,r.old_value,r.requested_value,r.status,r.created_at FROM profile_change_requests r JOIN participants p ON p.id=r.participant_id WHERE r.status=? ORDER BY r.created_at ASC LIMIT 200",[status]);
r.json({requests:rows});
});
app.post("/api/admin/profile-change-requests/:id/review",admin,async(q,r)=>{
if(!/^\\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه درخواست نامعتبر است."});
try{const result=await campaignService.reviewProfileChange({requestId:Number(q.params.id),approve:q.body.approve===true,note:q.body.note||""});r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
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
if(!equal(q.get("x-telegram-bot-api-secret-token")||"",secret))return r.status(401).send("Unauthorized");
const u=q.body||{};
if(typeof u.update_id!=="number"||!Number.isSafeInteger(u.update_id))return r.status(400).send("Invalid update");
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
server.requestTimeout=30000;
server.headersTimeout=15000;
server.keepAliveTimeout=5000;
server.maxRequestsPerSocket=1000;
webhookQueue.start();
notificationOutbox.start();
const reservationExpiryTimer=setInterval(()=>campaignService.expireReservations().catch(e=>console.error('Reservation expiry worker error:',e.message)),60000);
reservationExpiryTimer.unref?.();
let shuttingDown=false;
async function shutdown(signal){
if(shuttingDown)return;
shuttingDown=true;
console.log(signal+" received; draining webhook queue (30s limit)");
clearInterval(reservationExpiryTimer);
const serverClosed=new Promise(resolve=>server.close(resolve));
const forceExit=setTimeout(()=>{
console.error("Shutdown deadline exceeded; forcing process exit. Any unfinished webhook will be reclaimed by its lease.");
process.exit(1);
},65000);
const drained=await webhookQueue.stop(30000);
const notificationsDrained=await notificationOutbox.stop(30000);
if(!drained)console.error("Webhook queue did not drain within 30 seconds; exiting so the unfinished lease can be reclaimed.");
if(!notificationsDrained)console.error("Notification outbox did not drain within 30 seconds; unfinished notifications remain leased for recovery.");
await serverClosed;
await db.end();
clearTimeout(forceExit);
process.exit(drained&&notificationsDrained?0:1);
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));
