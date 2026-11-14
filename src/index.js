require("dotenv").config();
const express=require("express"), mysql=require("mysql2/promise"), crypto=require("crypto"), path=require("path");
for(const k of ["BOT_TOKEN","WEBHOOK_SECRET","ADMIN_PASSWORD","SESSION_SECRET","ADMIN_ID","DB_HOST","DB_NAME","DB_USER","DB_PASSWORD"]){if(!process.env[k]){console.error("Missing env:",k);process.exit(1)}}
const {normalizePhone,validPhone,normalizeInstagram,validInstagram,validFullName}=require("./domain");
const {createAdminTelegram}=require("./admin-telegram");
const {createCampaignService}=require("./campaign-service");
const {createBankCardService}=require("./bank-card-service");
const {createDrawService}=require("./draw-service");
const {createAccountAuth}=require("./account-auth");
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
const [[row]]=await db.execute("SELECT COUNT(*) AS total FROM campaigns WHERE status='open'");
return Number(row?.total||0)>0;
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
function contactGateKeyboard(){return {inline_keyboard:[[{text:"➕ افزودن مخاطب",callback_data:"contact:send"},{text:"ادامه",callback_data:"contact:confirm"}]]}}
function contactGateText(){return "به USTORE خوش آمدید 🌟\n\nبرای ادامه استفاده از ربات، شماره مدیریت USTORE را دریافت می‌کنید. در صورت تمایل آن را در مخاطبین ذخیره کنید و سپس ادامه دهید.\n\nنکته: ربات نمی‌تواند ذخیره‌شدن شماره را در مخاطبین گوشی بررسی کند و ذخیره شماره به‌تنهایی نمایش استوری‌های فروشگاه را تضمین نمی‌کند."}
function configuredContactPhone(){const phone=String(process.env.CONTACT_PHONE||"").replace(/[\s()-]/g,"");return /^\+?[0-9]{8,15}$/.test(phone)?phone:null}
async function contactGateAccepted(uid){
if(!configuredContactPhone())return true;
const [rows]=await db.execute("SELECT telegram_user_id FROM telegram_contact_gate WHERE telegram_user_id=? AND accepted_at IS NOT NULL LIMIT 1",[String(uid)]);
return rows.length>0;
}
async function showContactGate(chat,connection){return tg("sendMessage",{chat_id:chat,business_connection_id:connection||undefined,text:contactGateText(),reply_markup:contactGateKeyboard()})}
async function handleContactGateCallback(q,uid,chat){
const connection=String(q.message?.business_connection_id||"");
if(q.data==="contact:send"){
const phone=configuredContactPhone();
if(!phone){await tg("answerCallbackQuery",{callback_query_id:q.id,text:"شماره مدیریت هنوز در تنظیمات ربات ثبت نشده است. لطفاً بعداً مراجعه کنید.",show_alert:true});return;}
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"کارت مخاطب ارسال شد."});
await tg("sendContact",{chat_id:chat,business_connection_id:connection||undefined,phone_number:phone,first_name:"مدیریت",last_name:"USTORE"});
return reply(chat,connection,"کارت مخاطب ارسال شد. در صورت تمایل آن را ذخیره کنید و سپس «ذخیره کردم؛ ادامه» را بزنید. ربات نمی‌تواند ذخیره‌شدن شماره را بررسی کند.",{reply_markup:contactGateKeyboard()});
}
if(q.data==="contact:confirm"){
if(!configuredContactPhone()){await tg("answerCallbackQuery",{callback_query_id:q.id,text:"شماره مدیریت هنوز در تنظیمات ربات ثبت نشده است.",show_alert:true});return;}
await db.execute("INSERT INTO telegram_contact_gate(telegram_user_id,chat_id,accepted_at) VALUES(?,?,CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id),accepted_at=COALESCE(accepted_at,CURRENT_TIMESTAMP)",[String(uid),String(chat)]);
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"تأیید شد؛ خوش آمدید."});
const [campaigns]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency FROM campaigns WHERE status='open' ORDER BY id DESC LIMIT 20");
const buttons=campaigns.map(x=>[{text:x.name+" · "+(x.payment_mode==="free"?"رایگان":x.price_per_code+" "+x.currency),callback_data:"campaign:details:"+x.id}]);
buttons.push([{text:"👤 حساب من و کدها",callback_data:"participant:account"}]);
buttons.push([{text:"🔄 تازه‌سازی فهرست کمپین‌ها",callback_data:"campaign:list"}]);
buttons.push([{text:"👤 حساب و پروفایل",callback_data:"participant:account"},{text:"🎟 کدهای من",callback_data:"participant:codes"}]);
buttons.push([{text:"📝 ساخت پروفایل",callback_data:"profile:create"},{text:"💬 پشتیبانی",callback_data:"support:start"}]);
buttons.push([{text:"💳 سفارش‌های من",callback_data:"participant:orders"},{text:"🎫 تیکت‌های من",callback_data:"participant:tickets"}]);
return reply(chat,connection,campaigns.length?"دسترسی فعال شد. از منوی USTORE استفاده کنید:":"دسترسی فعال شد. کمپین فعالی نیست؛ می‌توانید پروفایل بسازید یا با پشتیبانی تماس بگیرید.",{reply_markup:{inline_keyboard:buttons}});
}
}
const adminTelegram=createAdminTelegram({db,tg,tgDocument,adminId:process.env.ADMIN_ID,registrationOpen,campaignService,bankCardService,drawService});
const accountAuth=createAccountAuth({app,db,tg,adminId:process.env.ADMIN_ID,sessionSecret,siteUrl:process.env.PUBLIC_SITE_URL||"https://"+String(process.env.DOMAIN||"")});
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
async function session(uid){const [r]=await db.execute("SELECT * FROM telegram_sessions WHERE telegram_user_id=?",[String(uid)]);const item=r[0];if(!item)return null;const age=Date.now()-new Date(item.updated_at).getTime();if(!Number.isFinite(age)||age>24*60*60*1000){await delSession(uid);return null}return item}
async function putSession(uid,chat,step,name,phone,conn,instagram=null){await db.execute(`INSERT INTO telegram_sessions(telegram_user_id,chat_id,step,full_name,phone,instagram,business_connection_id) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id),step=VALUES(step),full_name=VALUES(full_name),phone=VALUES(phone),instagram=VALUES(instagram),business_connection_id=VALUES(business_connection_id)`,[String(uid),String(chat),step,name,phone,instagram,conn])}
async function delSession(uid){await db.execute("DELETE FROM telegram_sessions WHERE telegram_user_id=?",[String(uid)])}
async function saveParticipantProfile(uid,chat,name,phone,inst,businessConnection){
const conn=await db.getConnection();
try{
await conn.beginTransaction();
const [[old]]=await conn.execute("SELECT id,status FROM participants WHERE telegram_user_id=? FOR UPDATE",[String(uid)]);
if(old){if(old.status!=="active")throw new Error("پروفایل شما غیرفعال است.");await conn.execute("UPDATE participants SET chat_id=?,business_connection_id=? WHERE id=?",[String(chat),businessConnection||null,old.id]);await conn.commit();return {participantId:old.id,created:false};}
const [duplicates]=await conn.execute("SELECT id FROM participants WHERE status='active' AND (phone=? OR LOWER(instagram)=LOWER(?)) AND telegram_user_id<>? LIMIT 1",[phone,inst,String(uid)]);
if(duplicates.length)throw Object.assign(new Error("DUPLICATE_CONTACT"),{code:"DUPLICATE_CONTACT"});
const [created]=await conn.execute("INSERT INTO participants(telegram_user_id,chat_id,business_connection_id,full_name,phone,instagram,status) VALUES(?,?,?,?,?,?,'active')",[String(uid),String(chat),businessConnection||null,name,phone,inst]);
await conn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",["customer-profile:"+uid,"customer_profile_created",JSON.stringify({method:"sendMessage",payload:{chat_id:String(process.env.ADMIN_ID),text:"پروفایل مشتری جدید: "+name+" | "+phone+" | @"+inst}})]);
await conn.commit();return {participantId:created.insertId,created:true};
}catch(e){await conn.rollback();if(e.code==="ER_DUP_ENTRY")throw Object.assign(new Error("DUPLICATE_CONTACT"),{code:"DUPLICATE_CONTACT"});throw e;}finally{conn.release();}
}
async function handleCallbackQuery(q){
if(!q?.id)return;
const uid=String(q.from?.id||"");
const chat=String(q.message?.chat?.id||"");
if(uid!==String(process.env.ADMIN_ID||"")&&q.message?.chat?.type==="private"){
if(q.data==="contact:send"||q.data==="contact:confirm")return handleContactGateCallback(q,uid,chat);
if(!await contactGateAccepted(uid)){await tg("answerCallbackQuery",{callback_query_id:q.id,text:"برای استفاده از ربات ابتدا مرحله خوش‌آمدگویی را تکمیل کنید.",show_alert:true});return showContactGate(chat,String(q.message?.business_connection_id||""));}
}
if(await accountAuth.handleCallback(q))return;
if(q.data==="reg:cancel"){
const current=await session(uid);
if(!uid||!current||String(current.chat_id)!==chat||String(current.business_connection_id||"")!==String(q.message?.business_connection_id||""))return tg("answerCallbackQuery",{callback_query_id:q.id,text:"این مرحله معتبر نیست یا منقضی شده است.",show_alert:true});
await delSession(uid);
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"عملیات لغو شد."});
return reply(chat,String(q.message?.business_connection_id||""),"عملیات لغو شد. از منوی اصلی می‌توانید دوباره شروع کنید.",{reply_markup:{inline_keyboard:[[{text:"🏠 منوی اصلی",callback_data:"participant:home"}]]}});
}
if(q.data==="profile:create"){
await tg("answerCallbackQuery",{callback_query_id:q.id});
const [[p]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? LIMIT 1",[uid]);
if(p)return reply(chat,String(q.message?.business_connection_id||""),"پروفایل شما قبلاً ساخته شده است.",{reply_markup:{inline_keyboard:[[{text:"👤 حساب من",callback_data:"participant:account"}]]}});
const connection=String(q.message?.business_connection_id||"");await putSession(uid,chat,"profile_name",null,null,connection);
return reply(chat,connection,"نام و نام خانوادگی خود را برای ساخت پروفایل دائمی وارد کنید؛ حتی بدون کمپین فعال.",{reply_markup:{inline_keyboard:[[{text:"لغو",callback_data:"reg:cancel"}]]}});
}
if(q.data==="profile:confirm"){
const s=await session(uid),connection=String(q.message?.business_connection_id||"");
if(!s||s.step!=="profile_confirmation"||String(s.chat_id)!==chat||String(s.business_connection_id||"")!==connection)return tg("answerCallbackQuery",{callback_query_id:q.id,text:"مرحله معتبر نیست یا منقضی شده است.",show_alert:true});
await tg("answerCallbackQuery",{callback_query_id:q.id,text:"در حال ساخت پروفایل..."});
try{
  await saveParticipantProfile(uid,chat,s.full_name,s.phone,s.instagram,connection);
  await delSession(uid);
  const [campaigns]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency FROM campaigns WHERE status='open' ORDER BY id DESC LIMIT 20");
  const buttons=campaigns.map(c=>[{text:c.name+" · "+(c.payment_mode==="free"?"رایگان":Number(c.price_per_code).toLocaleString("en-US")+" "+c.currency),callback_data:"campaign:details:"+c.id}]);
  buttons.push([{text:"👤 حساب من",callback_data:"participant:account"},{text:"🎟 کدهای من",callback_data:"participant:codes"}]);
  buttons.push([{text:"🔄 تازه‌سازی کمپین‌ها",callback_data:"campaign:list"}]);
  buttons.push([{text:"💬 پشتیبانی",callback_data:"support:start"}]);
  return reply(chat,connection,campaigns.length?"✅ ثبت‌نام شما با موفقیت تکمیل شد.\n\n🧩 کمپین‌های فعال را انتخاب کنید:":"✅ ثبت‌نام شما با موفقیت تکمیل شد.\n\nدر حال حاضر کمپین فعالی وجود ندارد؛ بعداً از همین بخش فهرست را تازه‌سازی کنید.",{reply_markup:{inline_keyboard:buttons}});
}catch(e){return reply(chat,connection,e.code==="DUPLICATE_CONTACT"?"این شماره یا آیدی اینستاگرام قبلاً ثبت شده است.":"ساخت پروفایل ناموفق بود؛ اطلاعات شما حفظ شده است.");}
}
if(String(q.data||'').startsWith('campaign:details:')){
  const campaignId=String(q.data.split(':')[2]||'');
  if(!uid||!chat||!/^[0-9]+$/.test(campaignId))return tg('answerCallbackQuery',{callback_query_id:q.id,text:'درخواست نامعتبر است.',show_alert:true});
  await tg('answerCallbackQuery',{callback_query_id:q.id});
  const [[campaign]]=await db.execute("SELECT id,name,description,payment_mode,price_per_code,currency,max_codes_per_participant FROM campaigns WHERE id=? AND status='open' LIMIT 1",[campaignId]);
  if(!campaign)return reply(chat,String(q.message?.business_connection_id||''),'این کمپین دیگر فعال نیست.');
  const price=campaign.payment_mode==='free'?'رایگان':Number(campaign.price_per_code).toLocaleString('en-US')+' '+campaign.currency+' برای هر کد';
  const body='🧩 '+campaign.name+'\n\n'+(campaign.description||'توضیحات تکمیلی برای این کمپین ثبت نشده است.')+'\n\n💳 شیوه شرکت: '+price+'\n🎟 حداکثر کد برای هر نفر: '+campaign.max_codes_per_participant+'\n\nبرای ادامه، دکمه زیر را بزنید.';
  return reply(chat,String(q.message?.business_connection_id||''),body,{reply_markup:{inline_keyboard:[[{text:'▶️ شروع ثبت‌نام',callback_data:'campaign:join:'+campaign.id}],[{text:'↩️ بازگشت به کمپین‌ها',callback_data:'campaign:list'}]]}});
}
if(q.data==='profile:edit:name'||q.data==='profile:edit:instagram'||q.data==='profile:edit:phone'){
await tg("answerCallbackQuery",{callback_query_id:q.id});
const connection=String(q.message?.business_connection_id||"");const field=q.data.split(':')[2];const [[p]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);if(!p)return reply(chat,connection,"پروفایل فعال پیدا نشد.");
const step=field==="name"?"profile_change_full_name":field==="instagram"?"profile_change_instagram":"profile_change_phone_contact";await putSession(uid,chat,step,null,null,connection);
if(field==="phone")return reply(chat,connection,"شماره جدید را با دکمه رسمی تلگرام ارسال کنید.",{reply_markup:{keyboard:[[{text:"📱 اشتراک‌گذاری شماره من",request_contact:true}]],resize_keyboard:true,one_time_keyboard:true}});
return reply(chat,connection,field==="name"?"نام جدید را ارسال کنید:":"آیدی اینستاگرام جدید را ارسال کنید:");
}
if(q.data==='support:start'){const connection=String(q.message?.business_connection_id||"");await putSession(uid,chat,"support_message",null,null,connection);await tg("answerCallbackQuery",{callback_query_id:q.id});return reply(chat,connection,"پیام خود را برای پشتیبانی بنویسید (۵ تا ۲۰۰۰ نویسه).");}
if(q.data==='participant:orders'){
  await tg("answerCallbackQuery",{callback_query_id:q.id});
  const [[p]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);
  if(!p)return reply(chat,String(q.message?.business_connection_id||""),"ابتدا پروفایل خود را بسازید.");
  const [rows]=await db.execute("SELECT o.id,o.order_ref,o.quantity,o.total_snapshot,o.currency,o.status,o.expires_at,c.name AS campaign_name FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id WHERE o.participant_id=? ORDER BY o.created_at DESC LIMIT 10",[p.id]);
  const labels={pending_payment:"در انتظار پرداخت",receipt_submitted:"رسید در حال بررسی",approved:"تأییدشده",rejected:"ردشده",expired:"منقضی",cancelled:"لغوشده"};
  const lines=rows.map((o,i)=>(i+1)+") "+o.campaign_name+"\nسفارش: "+o.order_ref+" | تعداد: "+o.quantity+" | مبلغ: "+Number(o.total_snapshot).toLocaleString("en-US")+" "+o.currency+"\nوضعیت: "+(labels[o.status]||o.status)+(o.status==="pending_payment"?"\nمهلت: "+new Date(o.expires_at).toLocaleString("fa-IR"):""));
  const buttons=rows.filter(o=>o.status==="pending_payment").flatMap(o=>[
    [{text:"📤 ادامه پرداخت "+o.order_ref,callback_data:"order:resume:"+o.id}],
    [{text:"✖️ لغو سفارش "+o.order_ref,callback_data:"order:cancel:"+o.id}]
  ]);
  buttons.push([{text:"🎟 کدهای من",callback_data:"participant:codes"},{text:"👤 حساب من",callback_data:"participant:account"}]);
  buttons.push([{text:"🏠 منوی اصلی",callback_data:"participant:home"}]);
  return reply(chat,String(q.message?.business_connection_id||""),lines.length?"💳 سفارش‌های شما\n\n"+lines.join("\n\n"):"هنوز سفارشی ثبت نکرده‌اید.",{reply_markup:{inline_keyboard:buttons}});
}
if(String(q.data||"").startsWith("order:cancel:")){
  const orderId=String(q.data.split(":")[2]||"");
  if(!/^\\d+$/.test(orderId))return tg("answerCallbackQuery",{callback_query_id:q.id,text:"شناسه سفارش نامعتبر است.",show_alert:true});
  await tg("answerCallbackQuery",{callback_query_id:q.id,text:"در حال لغو سفارش..."});
  try{
    const [[participant]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);
    if(!participant)throw new Error("پروفایل فعال پیدا نشد.");
    const result=await campaignService.cancelManualOrder({orderId:Number(orderId),participantId:participant.id});
    if(result.duplicate)return reply(chat,String(q.message?.business_connection_id||""),"این سفارش قبلاً لغو شده است.",{reply_markup:{inline_keyboard:[[{text:"💳 سفارش‌های من",callback_data:"participant:orders"}]]}});
    return reply(chat,String(q.message?.business_connection_id||""),"سفارش لغو شد و ظرفیت رزروشده آزاد شد.",{reply_markup:{inline_keyboard:[[{text:"💳 سفارش‌های من",callback_data:"participant:orders"}],[{text:"🧩 کمپین‌ها",callback_data:"campaign:list"}]]}});
  }catch(e){return reply(chat,String(q.message?.business_connection_id||""),"لغو سفارش انجام نشد: "+e.message);}
}
if(String(q.data||"").startsWith("order:resume:")){
  const orderId=String(q.data.split(":")[2]||"");
  if(!/^\\d+$/.test(orderId))return tg("answerCallbackQuery",{callback_query_id:q.id,text:"شناسه سفارش نامعتبر است.",show_alert:true});
  await tg("answerCallbackQuery",{callback_query_id:q.id});
  const [[order]]=await db.execute("SELECT o.id,o.order_ref,o.status,o.quantity,o.total_snapshot,o.currency,o.expires_at,o.terms_snapshot,c.name AS campaign_name,p.id AS participant_id FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id JOIN participants p ON p.id=o.participant_id WHERE o.id=? AND p.telegram_user_id=? LIMIT 1",[orderId,uid]);
  if(!order)return reply(chat,String(q.message?.business_connection_id||""),"این سفارش برای حساب شما پیدا نشد.");
  if(order.status!=="pending_payment")return reply(chat,String(q.message?.business_connection_id||""),"وضعیت این سفارش اجازه ادامه پرداخت نمی‌دهد. برای مشاهده آخرین وضعیت، سفارش‌های من را باز کنید.");
  if(new Date(order.expires_at).getTime()<=Date.now())return reply(chat,String(q.message?.business_connection_id||""),"مهلت این سفارش تمام شده است. از فهرست کمپین‌ها سفارش جدید ثبت کنید.");
  await db.execute("INSERT INTO campaign_payment_sessions(telegram_user_id,chat_id,business_connection_id,order_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id),business_connection_id=VALUES(business_connection_id),order_id=VALUES(order_id)",[uid,chat,String(q.message?.business_connection_id||""),order.id]);
  let terms={};try{terms=typeof order.terms_snapshot==="string"?JSON.parse(order.terms_snapshot):(order.terms_snapshot||{});}catch{}
  const card=terms.payment_card||null;
  const paymentDetails=card?"\n\n💳 اطلاعات کارت ثبت‌شده برای همین سفارش\n"+(card.bank_name?card.bank_name+"\n":"")+"شماره کارت: "+card.card_number+"\nبه نام: "+card.cardholder_name+"\n\nدر صورت پرداخت، رسید را همین‌جا ارسال کنید.": "\n\nاطلاعات کارت برای سفارش قدیمی در پرونده ذخیره نشده است. برای دریافت اطلاعات صحیح با پشتیبانی تماس بگیرید؛ کارت جدید را جایگزین اطلاعات قبلی فرض نکنید.";
  return reply(chat,String(q.message?.business_connection_id||""),"🔁 نشست پرداخت بازیابی شد.\nسفارش: "+order.order_ref+"\nکمپین: "+order.campaign_name+"\nمبلغ: "+Number(order.total_snapshot).toLocaleString("en-US")+" "+order.currency+paymentDetails,{reply_markup:{inline_keyboard:[[{text:"💳 مشاهده سفارش‌ها",callback_data:"participant:orders"}],[{text:"💬 پشتیبانی",callback_data:"support:start"}]]}});
}
if(q.data==='participant:tickets'){
  await tg("answerCallbackQuery",{callback_query_id:q.id});
  const [rows]=await db.execute("SELECT id,message,status,admin_reply,created_at,replied_at FROM customer_support_tickets WHERE telegram_user_id=? ORDER BY created_at DESC LIMIT 10",[uid]);
  const labels={open:"در انتظار پاسخ",answered:"پاسخ داده‌شده",closed:"بسته‌شده"};
  const body=rows.length?rows.map((x,i)=>(i+1)+") تیکت #"+x.id+" · "+(labels[x.status]||x.status)+"\nپیام شما: "+x.message+(x.admin_reply?"\nپاسخ پشتیبانی: "+x.admin_reply:"")).join("\n\n"):"هنوز تیکتی ثبت نکرده‌اید.";
  return reply(chat,String(q.message?.business_connection_id||""),body,{reply_markup:{inline_keyboard:[[{text:"➕ ثبت پیام جدید",callback_data:"support:start"}],[{text:"🏠 منوی اصلی",callback_data:"participant:home"}]]}});
}
if(q.data==='participant:codes'){await tg("answerCallbackQuery",{callback_query_id:q.id});const [[p]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);if(!p)return reply(chat,String(q.message?.business_connection_id||""),"ابتدا پروفایل بسازید.");const [rows]=await db.execute("SELECT c.name,cc.code FROM campaign_codes cc JOIN campaigns c ON c.id=cc.campaign_id WHERE cc.participant_id=? AND cc.status='active' ORDER BY cc.issued_at DESC LIMIT 100",[p.id]);return reply(chat,String(q.message?.business_connection_id||""),rows.length?rows.map((x,i)=>(i+1)+". "+x.name+" — "+x.code).join("\n"):"هنوز کدی ندارید.",{reply_markup:{inline_keyboard:[[{text:"👤 حساب من",callback_data:"participant:account"}],[{text:"🏠 منوی اصلی",callback_data:"participant:home"}]]}});}
if(q.data==='participant:account'){
  await tg('answerCallbackQuery',{callback_query_id:q.id});
  const [[p]]=await db.execute("SELECT id,full_name,phone,instagram,status FROM participants WHERE telegram_user_id=? LIMIT 1",[uid]);
  if(!p)return tg('sendMessage',{chat_id:chat,business_connection_id:String(q.message?.business_connection_id||'')||undefined,text:'هنوز پروفایلی ندارید. حتی بدون کمپین فعال می‌توانید پروفایل بسازید.',reply_markup:{inline_keyboard:[[{text:'📝 ساخت پروفایل',callback_data:'profile:create'}],[{text:'🧩 کمپین‌های فعال',callback_data:'campaign:list'}],[{text:'💬 پشتیبانی',callback_data:'support:start'}]]}});
  const [entries]=await db.execute("SELECT c.name,ce.status,GROUP_CONCAT(cc.code ORDER BY cc.id SEPARATOR ', ') AS codes FROM campaign_entries ce JOIN campaigns c ON c.id=ce.campaign_id LEFT JOIN campaign_codes cc ON cc.entry_id=ce.id AND cc.status='active' WHERE ce.participant_id=? GROUP BY ce.id,c.name,ce.status ORDER BY ce.created_at DESC LIMIT 20",[p.id]);
  const [orders]=await db.execute("SELECT o.order_ref,c.name,o.quantity,o.total_snapshot,o.currency,o.status FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id WHERE o.participant_id=? ORDER BY o.created_at DESC LIMIT 10",[p.id]);
  const labels={pending_payment:'در انتظار پرداخت',receipt_submitted:'رسید ارسال‌شده',approved:'تأییدشده',rejected:'ردشده',expired:'منقضی',cancelled:'لغوشده'};
  const et=entries.length?entries.map((x,i)=>(i+1)+') '+x.name+' · '+x.status+'\nکدها: '+(x.codes||'هنوز صادر نشده')).join('\n\n'):'هنوز در کمپینی ثبت‌نام نکرده‌اید.';
  const ot=orders.length?orders.map((x,i)=>(i+1)+') '+x.name+' · '+x.order_ref+'\nتعداد: '+x.quantity+' · مبلغ: '+x.total_snapshot+' '+x.currency+'\nوضعیت: '+(labels[x.status]||x.status)).join('\n\n'):'سفارشی ندارید.';
  return reply(chat,String(q.message?.business_connection_id||''),'👤 حساب شما\nنام: '+p.full_name+'\nموبایل: '+p.phone+'\nاینستاگرام: @'+p.instagram+'\nوضعیت: '+p.status+'\n\n🎟 کمپین‌ها و کدها\n'+et+'\n\n💳 سفارش‌ها\n'+ot,{reply_markup:{inline_keyboard:[[{text:'🧩 کمپین‌های فعال',callback_data:'campaign:list'}],[{text:'🎟 کدهای من',callback_data:'participant:codes'}],[{text:'✏️ اصلاح نام',callback_data:'profile:edit:name'},{text:'📱 اصلاح موبایل',callback_data:'profile:edit:phone'}],[{text:'📸 اصلاح اینستاگرام',callback_data:'profile:edit:instagram'}],[{text:'💬 پشتیبانی',callback_data:'support:start'}],[{text:'💳 سفارش‌های من',callback_data:'participant:orders'},{text:'🎫 تیکت‌های من',callback_data:'participant:tickets'}],[{text:'🏠 منوی اصلی',callback_data:'participant:home'}]]}});
}
if(q.data==='participant:home'){
 await tg('answerCallbackQuery',{callback_query_id:q.id});
 return reply(chat,String(q.message?.business_connection_id||''),'به USTORE خوش آمدید. یک بخش را انتخاب کنید:',{reply_markup:{inline_keyboard:[[{text:'🧩 مشاهده کمپین‌ها',callback_data:'campaign:list'}],[{text:'👤 حساب و پروفایل',callback_data:'participant:account'},{text:'🎟 کدهای من',callback_data:'participant:codes'}],[{text:'💳 سفارش‌های من',callback_data:'participant:orders'},{text:'🎫 تیکت‌های من',callback_data:'participant:tickets'}],[{text:'📝 ساخت پروفایل',callback_data:'profile:create'}],[{text:'💬 پشتیبانی',callback_data:'support:start'}]]}});
}
if(q.data==='campaign:list'){
  await tg('answerCallbackQuery',{callback_query_id:q.id});
  const [campaigns]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency FROM campaigns WHERE status='open' ORDER BY id DESC LIMIT 20");
  const buttons=campaigns.map(c=>[{text:c.name+' · '+(c.payment_mode==='free'?'رایگان':c.price_per_code+' '+c.currency),callback_data:'campaign:details:'+c.id}]);
  buttons.push([{text:'👤 حساب و پروفایل',callback_data:'participant:account'},{text:'🎟 کدهای من',callback_data:'participant:codes'}]);
  buttons.push([{text:'📝 ساخت پروفایل',callback_data:'profile:create'},{text:'💬 پشتیبانی',callback_data:'support:start'}]);
  return reply(chat,String(q.message?.business_connection_id||''),campaigns.length?'🧩 کمپین فعال موردنظرتان را انتخاب کنید:':'در حال حاضر کمپین بازی برای ثبت‌نام وجود ندارد. می‌توانید پروفایل بسازید یا از پشتیبانی کمک بگیرید.',{reply_markup:{inline_keyboard:buttons}});
}
if(String(q.data||'').startsWith('campaign:join:')){
  const uid=String(q.from?.id||''),chat=String(q.message?.chat?.id||''),connection=String(q.message?.business_connection_id||''),campaignId=String(q.data.split(':')[2]||'');
  if(!uid||!chat||!/^[0-9]+$/.test(campaignId))return tg('answerCallbackQuery',{callback_query_id:q.id,text:'درخواست نامعتبر است.',show_alert:true});
  await tg('answerCallbackQuery',{callback_query_id:q.id});
  try{
    const [[participant]]=await db.execute("SELECT * FROM participants WHERE telegram_user_id=? LIMIT 1",[uid]);
    if(participant&&participant.status!=='active')throw new Error('پروفایل شما غیرفعال است. برای بررسی با پشتیبانی تماس بگیرید.');
    if(!participant){
      await putSession(uid,chat,"profile_name",null,null,connection);
      return reply(chat,connection,"برای شرکت در کمپین، ابتدا پروفایل دائمی خود را تکمیل کنید.\n\nنام و نام خانوادگی خود را ارسال کنید. این اطلاعات فقط یک‌بار دریافت می‌شود و برای کمپین‌های بعدی محفوظ می‌ماند.");
    }
    const [[campaign]]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency,max_codes_per_participant FROM campaigns WHERE id=? AND status='open' LIMIT 1",[campaignId]);
    if(!campaign)throw new Error('این کمپین دیگر باز نیست.');
    const max=Math.max(1,Math.min(1000,Number(campaign.max_codes_per_participant)||1));
    await db.execute('UPDATE participants SET chat_id=?,business_connection_id=? WHERE id=?',[chat,connection,participant.id]);
    return tg('sendMessage',{chat_id:chat,business_connection_id:connection||undefined,text:'🎟 کمپین: '+campaign.name+'\nحداکثر تعداد مجاز برای هر نفر: '+max+'\n\nچند کد می‌خواهید دریافت کنید؟',reply_markup:campaignQuantityKeyboard(campaign.id,max,0)});
  }catch(e){return reply(chat,connection,'❌ امکان ادامه ثبت‌نام وجود ندارد: '+e.message);}
}
if(String(q.data||'').startsWith('campaign:quantity-page:')){
  const parts=String(q.data).split(':'),campaignId=parts[3]||'',page=Number(parts[4]);
  if(!uid||!chat||!/^[0-9]+$/.test(campaignId)||!Number.isInteger(page)||page<0)return tg('answerCallbackQuery',{callback_query_id:q.id,text:'درخواست نامعتبر است.',show_alert:true});
  const [[campaign]]=await db.execute("SELECT id,max_codes_per_participant FROM campaigns WHERE id=? AND status='open' LIMIT 1",[campaignId]);
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
    const [[campaign]]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency,max_codes_per_participant FROM campaigns WHERE id=? AND status='open' LIMIT 1",[campaignId]);
    if(!campaign)throw new Error('این کمپین دیگر باز نیست.');
    if(quantity>Number(campaign.max_codes_per_participant))throw new Error('تعداد انتخابی از سقف مجاز کمپین بیشتر است.');
    await db.execute('UPDATE participants SET chat_id=?,business_connection_id=? WHERE id=?',[chat,connection,participant.id]);
    if(campaign.payment_mode==='free'){
      await campaignService.joinFreeCampaign({campaignId:Number(campaignId),telegramUserId:uid,chatId:chat,businessConnectionId:connection,fullName:participant.full_name,phone:participant.phone,instagram:participant.instagram,quantity});
      return reply(chat,connection,'🎉 درخواست عضویت شما در کمپین «'+campaign.name+'» با '+quantity+' کد ثبت شد. کدها در پیام جداگانه برایتان ارسال می‌شوند.');
    }
    if(campaign.payment_mode!=='manual')throw new Error('درگاه پرداخت این کمپین هنوز فعال نشده است.');
    const order=await campaignService.reserveManualOrder({campaignId:Number(campaignId),participantId:participant.id,quantity});
    if(order.duplicate)return reply(chat,connection,'این سفارش قبلاً ثبت شده و برای جلوگیری از سفارش تکراری دوباره ساخته نشد. برای بازیابی اطلاعات پرداخت و ارسال رسید ادامه دهید.',{reply_markup:{inline_keyboard:[[{text:'📤 ادامه سفارش '+order.orderRef,callback_data:'order:resume:'+order.id}],[{text:'💳 سفارش‌های من',callback_data:'participant:orders'}]]}});
    return reply(chat,connection,'✅ سفارش '+order.orderRef+' ثبت شد. دستور پرداخت و اطلاعات کارت از طریق پیام جداگانه ارسال می‌شود.');
  }catch(e){return reply(chat,connection,'❌ امکان ثبت‌نام در این کمپین وجود ندارد: '+e.message);}
}
const adminHandled=await adminTelegram.handleCallback(q);if(adminHandled!==false)return adminHandled;
}

async function handlePrivateUpdate(update){
const m=update.message;
if(!m?.from||m.from.is_bot||!m.chat||m.chat.type!=="private")return;
if(String(m.from.id)!==String(process.env.ADMIN_ID||"")&&!await contactGateAccepted(m.from.id))return showContactGate(m.chat.id,"");
if(await accountAuth.handleMessage(m))return;
if(String(m.from.id)===String(process.env.ADMIN_ID||"")&&String(m.text||"").trim().startsWith("/reply"))return handleUpdate({business_message:{...m,business_connection_id:""}});
const adminHandled=await adminTelegram.handleMessage(m);
if(adminHandled!==false)return adminHandled;
return handleUpdate({business_message:{...m,business_connection_id:""}});
}

async function handleUpdate(update){
const m=update.business_message;
if(!m?.from||!m.chat||m.from.is_bot||m.chat.type!=="private")return;
const uid=String(m.from.id),chat=String(m.chat.id),conn=String(m.business_connection_id||""),t=String(m.text||m.caption||'').trim(),lower=t.toLowerCase();
if(uid!==String(process.env.ADMIN_ID||"")&&!await contactGateAccepted(uid))return showContactGate(chat,conn);
if(m.contact){
  const s=await session(uid);
  if(!s||!["profile_awaiting_contact","profile_change_phone_contact"].includes(s.step)||String(s.chat_id)!==chat||String(s.business_connection_id||"")!==conn)return reply(chat,conn,"درخواست ارسال شماره فعال نیست. برای شروع دوباره /start را بزنید.");
  if(!m.contact.user_id||String(m.contact.user_id)!==uid)return reply(chat,conn,"❌ فقط شماره متعلق به حساب تلگرام خودتان پذیرفته می‌شود.");
  const phone=normalizePhone(m.contact.phone_number||"");
  if(!validPhone(phone))return reply(chat,conn,"شماره دریافت‌شده معتبر نیست. لطفاً دوباره از دکمه اشتراک‌گذاری شماره استفاده کنید.");
  if(s.step==="profile_change_phone_contact"){try{const [[p]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);if(!p)throw new Error("پروفایل فعال پیدا نشد.");const request=await campaignService.requestProfileChange({participantId:p.id,field:"phone",value:phone,telegramMessageId:m.message_id});await delSession(uid);return reply(chat,conn,"درخواست اصلاح شماره ثبت شد. شناسه: "+request.id,{reply_markup:{remove_keyboard:true}});}catch(e){return reply(chat,conn,"اصلاح شماره ثبت نشد: "+e.message,{reply_markup:{remove_keyboard:true}});}}
  await putSession(uid,chat,"profile_instagram",s.full_name,phone,conn);
  return reply(chat,conn,"شماره موبایل تأیید شد. حالا آیدی اینستاگرام خود را بفرستید؛ مثال: @example",{reply_markup:{remove_keyboard:true}});
}
if(m.photo?.length||m.document){
  const [[paymentSession]]=await db.execute('SELECT order_id FROM campaign_payment_sessions WHERE telegram_user_id=? AND chat_id=? AND business_connection_id=? LIMIT 1',[uid,chat,conn]);
  if(!paymentSession)return reply(chat,conn,"برای ثبت رسید، ابتدا از بخش «سفارش‌های من» سفارش در انتظار پرداخت را انتخاب و نشست آن را بازیابی کنید.",{reply_markup:{inline_keyboard:[[{text:"💳 سفارش‌های من",callback_data:"participant:orders"}],[{text:"💬 پشتیبانی",callback_data:"support:start"}]]}});
  try{
    const photo=m.photo?.length?m.photo[m.photo.length-1]:null;
    const document=m.document||null;
    const mime=String(document?.mime_type||"").toLowerCase();
    if(document&&(Number(document.file_size||0)>10*1024*1024||!["application/pdf","image/jpeg","image/png","image/webp"].includes(mime)))return reply(chat,conn,"فایل رسید باید PDF یا تصویر JPG/PNG/WEBP و حداکثر ۱۰ مگابایت باشد.");
    const file=photo||document;
    if(Number(file.file_size||0)>10*1024*1024)return reply(chat,conn,"حجم رسید نباید بیشتر از ۱۰ مگابایت باشد.");
    const receiptResult=await campaignService.submitReceipt({orderId:paymentSession.order_id,fileId:file.file_id,fileUniqueId:file.file_unique_id,trackingReference:m.caption||null});
    await db.execute('DELETE FROM campaign_payment_sessions WHERE telegram_user_id=?',[uid]);
    if(receiptResult.duplicate)return reply(chat,conn,'این رسید قبلاً دریافت شده و در صف بررسی مدیر قرار دارد. وضعیت سفارش را از بخش «سفارش‌های من» پیگیری کنید.');
    return; // The durable outbox sends the first receipt acknowledgement exactly once per order key.
  }catch(e){return reply(chat,conn,'❌ رسید ثبت نشد: '+e.message+'\nاگر مهلت سفارش تمام شده باشد دوباره از فهرست کمپین‌ها اقدام کنید.');}
}
if(lower==='/orders'||lower==='سفارش‌های من'||lower==='سفارش های من')return reply(chat,conn,"برای مشاهده وضعیت سفارش‌ها، دکمه زیر را بزنید:",{reply_markup:{inline_keyboard:[[{text:"💳 سفارش‌های من",callback_data:"participant:orders"}]]}});
if(lower==='/tickets'||lower==='تیکت‌های من'||lower==='تیکت های من')return reply(chat,conn,"برای مشاهده پیام‌های پشتیبانی، دکمه زیر را بزنید:",{reply_markup:{inline_keyboard:[[{text:"🎫 تیکت‌های من",callback_data:"participant:tickets"}]]}});
if(lower==='/account'||lower==='/profile'||lower==='حساب من'||lower==='پروفایل من'){
  const [[participant]]=await db.execute("SELECT id,full_name,phone,instagram,status FROM participants WHERE telegram_user_id=? LIMIT 1",[uid]);
  if(!participant)return reply(chat,conn,"هنوز پروفایلی ندارید. برای شروع، /campaigns را بزنید و یک کمپین را انتخاب کنید.");
  const [entries]=await db.execute("SELECT c.name,ce.status,GROUP_CONCAT(cc.code ORDER BY cc.id SEPARATOR ', ') AS codes FROM campaign_entries ce JOIN campaigns c ON c.id=ce.campaign_id LEFT JOIN campaign_codes cc ON cc.entry_id=ce.id AND cc.status='active' WHERE ce.participant_id=? GROUP BY ce.id,c.name,ce.status ORDER BY ce.created_at DESC LIMIT 20",[participant.id]);
  const [orders]=await db.execute("SELECT o.order_ref,c.name,o.quantity,o.total_snapshot,o.currency,o.status FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id WHERE o.participant_id=? ORDER BY o.created_at DESC LIMIT 10",[participant.id]);
  const statusLabel={pending_payment:'در انتظار پرداخت',receipt_submitted:'رسید ارسال‌شده',approved:'تأییدشده',rejected:'ردشده',expired:'منقضی',cancelled:'لغوشده'};
  const entryText=entries.length?entries.map((x,i)=>(i+1)+') '+x.name+' · '+x.status+'\nکدها: '+(x.codes||'هنوز صادر نشده')).join('\n\n'):'هنوز در کمپینی ثبت‌نام نکرده‌اید.';
  const orderText=orders.length?orders.map((x,i)=>(i+1)+') '+x.name+' · سفارش '+x.order_ref+'\nتعداد: '+x.quantity+' · مبلغ: '+x.total_snapshot+' '+x.currency+'\nوضعیت: '+(statusLabel[x.status]||x.status)).join('\n\n'):'سفارشی ندارید.';
  return reply(chat,conn,'👤 پروفایل شما\nنام: '+participant.full_name+'\nموبایل: '+participant.phone+'\nاینستاگرام: @'+participant.instagram+'\nوضعیت: '+participant.status+'\n\n🎟 کمپین‌ها و کدهای شما\n'+entryText+'\n\n💳 سفارش‌ها\n'+orderText,{reply_markup:{inline_keyboard:[[{text:'🧩 کمپین‌های فعال',callback_data:'campaign:list'}]]}});
}
if(lower==='/start'||lower==='لاتاری'||lower==='کمپین‌ها'||lower==='کمپین ها'||lower==='/campaigns'){
  const [[existingProfile]]=await db.execute("SELECT id,status FROM participants WHERE telegram_user_id=? LIMIT 1",[uid]);
  if(!existingProfile){
    await putSession(uid,chat,"profile_name",null,null,conn);
    return reply(chat,conn,"به USTORE خوش آمدید. برای مشاهده و شرکت در کمپین‌ها، ابتدا ثبت‌نام کوتاه خود را تکمیل کنید.\n\nنام و نام خانوادگی خود را وارد کنید:",{reply_markup:{inline_keyboard:[[{text:"✖️ انصراف",callback_data:"reg:cancel"}]]}});
  }
  if(existingProfile.status!=="active"){
    return reply(chat,conn,"حساب شما در حال حاضر غیرفعال است. برای بررسی و فعال‌سازی با پشتیبانی تماس بگیرید.",{reply_markup:{inline_keyboard:[[{text:"💬 پشتیبانی",callback_data:"support:start"}]]}});
  }
  const [campaigns]=await db.execute("SELECT id,name,payment_mode,price_per_code,currency FROM campaigns WHERE status='open' ORDER BY id DESC LIMIT 20");
  const buttons=campaigns.map(x=>[{text:x.name+' · '+(x.payment_mode==='free'?'رایگان':x.price_per_code+' '+x.currency),callback_data:'campaign:details:'+x.id}]);
  buttons.push([{text:'👤 حساب و پروفایل',callback_data:'participant:account'},{text:'🎟 کدهای من',callback_data:'participant:codes'}]);
  buttons.push([{text:'📝 ساخت پروفایل',callback_data:'profile:create'},{text:'💬 پشتیبانی',callback_data:'support:start'}]);
  buttons.push([{text:'🔄 تازه‌سازی کمپین‌ها',callback_data:'campaign:list'}]);
  return reply(chat,conn,campaigns.length?'به USTORE خوش آمدید؛ کمپین موردنظرتان را انتخاب کنید:':'در حال حاضر کمپین بازی برای ثبت‌نام وجود ندارد. می‌توانید پروفایل بسازید یا از پشتیبانی کمک بگیرید.',{reply_markup:{inline_keyboard:buttons}});
}


if(lower==="/cancel"||t==="لغو"){await delSession(uid);return reply(chat,conn,"عملیات لغو شد. از منوی اصلی می‌توانید دوباره شروع کنید.",{reply_markup:{inline_keyboard:[[{text:"🏠 منوی اصلی",callback_data:"participant:home"}]]}});}
const currentSession=await session(uid);
if(currentSession?.step==="profile_name"){
if(!validFullName(t))return reply(chat,conn,"نام و نام خانوادگی معتبر وارد کنید.");
await putSession(uid,chat,"profile_awaiting_contact",t.trim().replace(/\s+/g," "),null,conn);
return reply(chat,conn,"شماره متعلق به حساب تلگرام خود را با دکمه رسمی زیر ارسال کنید.",{reply_markup:{keyboard:[[{text:"📱 اشتراک‌گذاری شماره من",request_contact:true}]],resize_keyboard:true,one_time_keyboard:true}});
}
if(currentSession?.step==="profile_instagram"){
const inst=normalizeInstagram(t);if(!validInstagram(inst))return reply(chat,conn,"آیدی اینستاگرام معتبر نیست.");
await putSession(uid,chat,"profile_confirmation",currentSession.full_name,currentSession.phone,conn,inst);
return reply(chat,conn,"اطلاعات را بررسی کنید:\nنام: "+currentSession.full_name+"\nموبایل: "+currentSession.phone+"\nاینستاگرام: @"+inst,{reply_markup:{inline_keyboard:[[{text:"✅ تأیید و ساخت پروفایل",callback_data:"profile:confirm"}],[{text:"لغو",callback_data:"reg:cancel"}]]}});
}
if(currentSession?.step==="profile_change_full_name"||currentSession?.step==="profile_change_instagram"){
const field=currentSession.step==="profile_change_full_name"?"full_name":"instagram";
try{const [[p]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);if(!p)throw new Error("پروفایل فعال پیدا نشد.");const request=await campaignService.requestProfileChange({participantId:p.id,field,value:t,telegramMessageId:m.message_id});await delSession(uid);return reply(chat,conn,"درخواست اصلاح ثبت شد؛ پس از بررسی مدیر اعمال می‌شود. شناسه: "+request.id);}catch(e){return reply(chat,conn,"درخواست اصلاح ثبت نشد: "+e.message);}
}
if(currentSession?.step==="support_message"){
if(t.length<5||t.length>2000)return reply(chat,conn,"پیام باید بین ۵ تا ۲۰۰۰ نویسه باشد.");
const messageId=Number(m.message_id);
if(!Number.isSafeInteger(messageId)||messageId<=0)return reply(chat,conn,"شناسه پیام تلگرام معتبر نیست؛ لطفاً پیام را دوباره ارسال کنید.");
const ticketConn=await db.getConnection();
let ticketId;
try{
  await ticketConn.beginTransaction();
  const [ticket]=await ticketConn.execute("INSERT INTO customer_support_tickets(telegram_user_id,chat_id,business_connection_id,message,telegram_message_id,status) VALUES(?,?,?,?,?,'open') ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)",[uid,chat,conn||null,t,messageId]);
  ticketId=Number(ticket.insertId);
  await ticketConn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",["support-ticket:"+ticketId,"customer_support_ticket",JSON.stringify({method:"sendMessage",payload:{chat_id:String(process.env.ADMIN_ID),text:"پیام پشتیبانی #"+ticketId+" از "+uid+": "+t+"\nپاسخ: /reply "+ticketId+" متن پاسخ"}})]);
  await ticketConn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",["support-ticket-customer:"+ticketId,"support_ticket_acknowledgement",JSON.stringify({method:"sendMessage",payload:{chat_id:chat,...(conn?{business_connection_id:conn}:{}),text:"پیام شما ثبت شد. شماره پیگیری: #"+ticketId}})]);
  await ticketConn.execute("DELETE FROM telegram_sessions WHERE telegram_user_id=?",[uid]);
  await ticketConn.commit();
}catch(error){await ticketConn.rollback();throw error;}
finally{ticketConn.release();}
return; // Customer acknowledgement is delivered through the durable, deduplicated outbox.
}
const profileChangeMatch=t.match(/^اصلاح\s+(نام|موبایل|اینستاگرام)\s*[:：]\s*(.+)$/);
if(profileChangeMatch){
  const fieldMap={'نام':'full_name','موبایل':'phone','اینستاگرام':'instagram'};
  try{
    const [[participant]]=await db.execute("SELECT id FROM participants WHERE telegram_user_id=? AND status='active' LIMIT 1",[uid]);
    if(!participant)return reply(chat,conn,'پروفایل کمپین شما پیدا نشد. ابتدا «لاتاری» را تکمیل کنید و دوباره تلاش کنید.');
    const request=await campaignService.requestProfileChange({participantId:participant.id,field:fieldMap[profileChangeMatch[1]],value:profileChangeMatch[2].trim(),telegramMessageId:m.message_id});
    return reply(chat,conn,'📝 درخواست اصلاح اطلاعات ثبت شد. پس از بررسی مدیر نتیجه اعلام می‌شود.\nشناسه درخواست: '+request.id);
  }catch(e){return reply(chat,conn,'❌ درخواست اصلاح ثبت نشد: '+e.message);}
}

if(lower==="/reply"||lower.startsWith("/reply ")){
if(uid!==String(process.env.ADMIN_ID||""))return;
const match=t.match(/^\/reply\s+(\d+)\s+([\s\S]{2,2000})$/i);
if(!match)return reply(chat,conn,"فرمت پاسخ: /reply شماره_تیکت متن پاسخ");
const ticketId=Number(match[1]),answer=match[2].trim();
const replyConn=await db.getConnection();
let queued=false;
try{
  await replyConn.beginTransaction();
  const [[ticket]]=await replyConn.execute("SELECT id,chat_id,business_connection_id,status FROM customer_support_tickets WHERE id=? FOR UPDATE",[ticketId]);
  if(!ticket){await replyConn.rollback();return reply(chat,conn,"تیکت پیدا نشد.");}
  if(ticket.status!=="open"){await replyConn.rollback();return reply(chat,conn,"این تیکت قبلاً پاسخ داده شده است.");}
  await replyConn.execute("UPDATE customer_support_tickets SET status='answered',admin_reply=?,replied_at=UTC_TIMESTAMP(),replied_by=? WHERE id=? AND status='open'",[answer,String(uid),ticketId]);
  await replyConn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",["support-reply:"+ticketId,"support_ticket_reply",JSON.stringify({method:"sendMessage",payload:{chat_id:String(ticket.chat_id),...(ticket.business_connection_id?{business_connection_id:String(ticket.business_connection_id)}:{}),text:"💬 پاسخ پشتیبانی USTORE\n\n"+answer}})]);
  await replyConn.commit();queued=true;
}catch(error){await replyConn.rollback();throw error;}
finally{replyConn.release();}
return reply(chat,conn,queued?"پاسخ تیکت #"+ticketId+" در صف ارسال مطمئن قرار گرفت.":"پاسخ ثبت نشد.");
}
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
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه کمپین نامعتبر است."});
try{const result=await campaignService.setCampaignStatus(Number(q.params.id),String(q.body.status||""),String(q.body.reason||""));await audit("admin","campaign_status","campaign",q.params.id,{status:result.status,reason:q.body.reason||""});r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.get("/api/admin/payment-orders",admin,async(q,r)=>{
const status=String(q.query.status||"receipt_submitted");
if(!["pending_payment","receipt_submitted","approved","rejected","expired","cancelled"].includes(status))return r.status(400).json({error:"فیلتر وضعیت نامعتبر است."});
const [rows]=await db.execute("SELECT o.id,o.order_ref,o.campaign_id,c.name AS campaign_name,o.participant_id,p.full_name,p.phone,o.quantity,o.total_snapshot,o.currency,o.status,o.expires_at,o.created_at FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id JOIN participants p ON p.id=o.participant_id WHERE o.status=? ORDER BY o.created_at ASC LIMIT 200",[status]);
r.json({orders:rows});
});
app.get("/api/admin/payment-orders/:id/receipt",admin,async(q,r)=>{
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه سفارش نامعتبر است."});
const [rows]=await db.execute("SELECT telegram_file_id FROM payment_receipts WHERE order_id=? ORDER BY submitted_at DESC LIMIT 1",[q.params.id]);
if(!rows.length)return r.status(404).json({error:"رسیدی برای این سفارش ثبت نشده است."});
try{
const file=await tg("getFile",{file_id:rows[0].telegram_file_id});
if(!file?.file_path)throw new Error("Telegram file path missing");
const response=await fetch("https://api.telegram.org/file/bot"+token+"/"+file.file_path);
if(!response.ok)throw new Error("Telegram receipt download failed");
const bytes=Buffer.from(await response.arrayBuffer());
if(bytes.length>12*1024*1024)return r.status(413).json({error:"حجم رسید بیش از حد مجاز است."});
const ext=String(file.file_path).split(".").pop().toLowerCase();
const mime=ext==="png"?"image/png":ext==="webp"?"image/webp":ext==="pdf"?"application/pdf":"image/jpeg";
r.setHeader("Content-Type",mime);r.setHeader("Content-Disposition","inline; filename=payment-receipt."+ext);r.setHeader("Cache-Control","private, no-store");return r.send(bytes);
}catch(e){console.error("Receipt preview error:",e.message);return r.status(502).json({error:"دریافت تصویر رسید از تلگرام انجام نشد."});}
});
app.post("/api/admin/payment-orders/:id/review",admin,async(q,r)=>{
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه سفارش نامعتبر است."});
try{const result=await campaignService.reviewManualPayment({orderId:Number(q.params.id),approve:q.body.approve===true,trackingReference:q.body.tracking_reference||null,note:q.body.note||""});r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.post("/api/admin/campaigns/:id/draws/prepare",admin,async(q,r)=>{
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه کمپین نامعتبر است."});
try{const result=await drawService.prepareDraw(Number(q.params.id));r.status(201).json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.get("/api/admin/draws/:id/candidates",admin,async(q,r)=>{
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه قرعه‌کشی نامعتبر است."});
const [[draw]]=await db.execute("SELECT id,campaign_id,method,status,draw_basis,snapshot_hash,winner_count,alternate_count FROM campaign_draws WHERE id=? LIMIT 1",[q.params.id]);
if(!draw)return r.status(404).json({error:"قرعه‌کشی پیدا نشد."});
const [candidates]=await db.execute("SELECT candidate_reference,participant_id,code FROM draw_candidates WHERE draw_id=? AND eligibility='eligible' ORDER BY candidate_reference",[q.params.id]);
r.json({draw,candidates});
});
app.post("/api/admin/draws/:id/run",admin,async(q,r)=>{
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه قرعه‌کشی نامعتبر است."});
try{const result=await drawService.runSystemDraw(Number(q.params.id));r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.post("/api/admin/draws/:id/live-results",admin,async(q,r)=>{
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه قرعه‌کشی نامعتبر است."});
try{const result=await drawService.submitLiveWheelResults({drawId:Number(q.params.id),candidateReferences:q.body.candidate_references,externalReference:q.body.external_reference,evidenceHash:q.body.evidence_hash});r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.post("/api/admin/draws/:id/approve",admin,async(q,r)=>{
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه قرعه‌کشی نامعتبر است."});
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
if(!/^\d+$/.test(String(q.params.id)))return r.status(400).json({error:"شناسه درخواست نامعتبر است."});
try{const result=await campaignService.reviewProfileChange({requestId:Number(q.params.id),approve:q.body.approve===true,note:q.body.note||""});r.json({ok:true,...result});}
catch(e){r.status(400).json({error:e.message});}
});
app.get("/api/admin/participants",admin,async(q,r)=>{
const term=String(q.query.q||"").trim().slice(0,100),like="%"+term+"%",limit=Math.min(100,Math.max(1,Number(q.query.limit)||50));
const [rows]=await db.execute(`SELECT p.id,p.telegram_user_id,p.full_name,p.phone,p.instagram,p.status,p.created_at,
(SELECT COUNT(*) FROM campaign_entries e WHERE e.participant_id=p.id AND e.status='active') AS campaign_count,
(SELECT COUNT(*) FROM campaign_codes cc WHERE cc.participant_id=p.id AND cc.status='active') AS active_codes
FROM participants p WHERE (?='' OR p.full_name LIKE ? OR p.phone LIKE ? OR p.instagram LIKE ? OR p.telegram_user_id LIKE ?)
ORDER BY p.created_at DESC,p.id DESC LIMIT ${limit}`,[term,like,like,like,like]);
r.json({participants:rows,limit});
});
async function audit(adminId,action,type,id,details={}) {
  await db.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",[String(adminId),action,type,String(id),JSON.stringify(details)]);
}
app.get("/api/admin/audit",admin,async(q,r)=>{
  const limit=Math.min(100,Math.max(1,Number(q.query.limit)||20));
  const [events]=await db.execute("SELECT id,admin_id,action,entity_type,entity_id,details,created_at FROM admin_audit_log ORDER BY id DESC LIMIT "+limit);
  r.json({events});
});
app.get("/api/admin/export.csv",admin,async(q,r)=>{
  const [rows]=await db.execute(`SELECT p.full_name,p.phone,p.instagram,c.name AS campaign_name,cc.code,ce.status AS membership_status,cc.issued_at
    FROM participants p LEFT JOIN campaign_entries ce ON ce.participant_id=p.id
    LEFT JOIN campaigns c ON c.id=ce.campaign_id
    LEFT JOIN campaign_codes cc ON cc.entry_id=ce.id AND cc.status='active'
    WHERE p.status<>'deleted' ORDER BY p.created_at DESC,p.id DESC,cc.id ASC`);
  const cell=v=>{let x=String(v??'');if(/^[\s]*[=+\-@]/.test(x))x="'"+x;return '"'+x.replace(/"/g,'""')+'"';};
  const csv='\uFEFF'+[['نام','موبایل','اینستاگرام','کمپین','کد','وضعیت عضویت','زمان صدور'],...rows.map(x=>[x.full_name,x.phone,'@'+x.instagram,x.campaign_name||'',x.code||'',x.membership_status||'',x.issued_at||''])].map(row=>row.map(cell).join(',')).join('\r\n');
  r.setHeader('Content-Type','text/csv; charset=utf-8');
  r.setHeader('Content-Disposition','attachment; filename="ustore-campaign-participants.csv"');
  r.setHeader('Cache-Control','private, no-store');
  return r.send(csv);
});
app.get("/api/admin/stats",admin,async(_q,r)=>{
const [[participants]]=await db.query("SELECT COUNT(*) total,SUM(status='active') active FROM participants");
const [[memberships]]=await db.query("SELECT COUNT(*) total,SUM(status='active') active,SUM(status='pending') pending FROM campaign_entries");
const [[codes]]=await db.query("SELECT COUNT(*) total FROM campaign_codes WHERE status='active'");
const [[orders]]=await db.query("SELECT COUNT(*) total,SUM(status='approved') approved,SUM(status='pending_payment') pending FROM payment_orders");
const [[failed]]=await db.query("SELECT COUNT(*) total FROM webhook_inbox WHERE status='failed'");
const [[openCampaigns]]=await db.query("SELECT COUNT(*) total FROM campaigns WHERE status='open'");
r.json({total:participants.total,activeParticipants:participants.active,memberships:memberships.total,activeMemberships:memberships.active,pending:orders.pending,activeCodes:codes.total,orders:orders.total,approvedOrders:orders.approved,failedUpdates:failed.total,open:openCampaigns.total>0,openCampaigns:openCampaigns.total});
});
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
