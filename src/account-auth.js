'use strict';
const crypto = require('crypto');

function createAccountAuth({ app, db, tg, adminId, sessionSecret, botUsername, siteUrl, logger = console }) {
  const cookieName = 'ustore_account';
  const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
  const sign = value => crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
  const safeEqual = (a, b) => { const x=Buffer.from(String(a)); const y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); };
  const randomToken = () => crypto.randomBytes(32).toString('base64url');
  const passwordHash = password => new Promise((resolve,reject) => crypto.scrypt(password, process.env.PASSWORD_PEPPER || sessionSecret, 64, (e,key)=>e?reject(e):resolve('scrypt$'+key.toString('hex'))));
  const verifyPassword = async (password, stored) => {
    if (!String(stored||'').startsWith('scrypt$')) return false;
    const expected=Buffer.from(stored.slice(7),'hex');
    const actual=await new Promise((resolve,reject)=>crypto.scrypt(password,process.env.PASSWORD_PEPPER||sessionSecret,64,(e,key)=>e?reject(e):resolve(key)));
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  };
  const cookie = (res, value, maxAge) => res.setHeader('Set-Cookie', cookieName+'='+encodeURIComponent(value)+'; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age='+maxAge);
  const clearCookie = res => res.setHeader('Set-Cookie',cookieName+'=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  function readCookie(req) {
    const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='));
    if(!raw)return null;
    try {
      const value=decodeURIComponent(raw.slice(cookieName.length+1)), i=value.lastIndexOf('.');
      if(i<1)return null;
      const payload=value.slice(0,i), signature=value.slice(i+1);
      if(!safeEqual(signature,sign(payload)))return null;
      const claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
      return claims.exp>Date.now()?claims:null;
    } catch { return null; }
  }
  const account = req => readCookie(req);
  function setSession(res, row) {
    const payload=Buffer.from(JSON.stringify({id:Number(row.id),phone:row.phone,exp:Date.now()+7*86400000})).toString('base64url');
    cookie(res,payload+'.'+sign(payload),7*86400);
  }
  function normalizePhone(value) {
    let p=String(value||'').replace(/[\s()+-]/g,'');
    if(p.startsWith('0098'))p='0'+p.slice(4);
    else if(p.startsWith('98'))p='0'+p.slice(2);
    return p;
  }
  const validPhone = p => /^09\d{9}$/.test(p);
  const fail = (res,status,message) => res.status(status).json({error:message});
  app.post('/api/account/register', async (req,res) => {
    const phone=normalizePhone(req.body.phone), password=String(req.body.password||'');
    if(!validPhone(phone))return fail(res,400,'شماره موبایل معتبر نیست.');
    if(password.length<10 || password.length>128)return fail(res,400,'رمز عبور باید حداقل ۱۰ و حداکثر ۱۲۸ کاراکتر باشد.');
    const [[link]]=await db.execute('SELECT l.telegram_user_id,l.chat_id FROM account_telegram_links l JOIN participants p ON p.telegram_user_id=l.telegram_user_id AND p.phone=? AND p.status=\'active\' LIMIT 1',[phone]);
    if(!link)return fail(res,403,'ابتدا با همان حساب تلگرام، ربات را Start کنید و مطمئن شوید شماره شما در پروفایل شرکت‌کننده ثبت شده است.');
    const password_hash=await passwordHash(password);
    try {
      await db.execute('INSERT INTO web_accounts(phone,telegram_user_id,password_hash) VALUES(?,?,?)',[phone,String(link.telegram_user_id),password_hash]);
    } catch(e) {
      if(e.code==='ER_DUP_ENTRY')return fail(res,409,'برای این شماره یا حساب تلگرام قبلاً حساب سایت ساخته شده است.');
      throw e;
    }
    const [[row]]=await db.execute('SELECT id,phone FROM web_accounts WHERE phone=?',[phone]);
    setSession(res,row);
    return res.status(201).json({ok:true,phone,telegram_linked:true});
  });
  app.post('/api/account/login', async (req,res) => {
    const phone=normalizePhone(req.body.phone), password=String(req.body.password||'');
    if(!validPhone(phone)||!password)return fail(res,400,'شماره موبایل یا رمز عبور نامعتبر است.');
    const [[row]]=await db.execute('SELECT id,phone,password_hash FROM web_accounts WHERE phone=? LIMIT 1',[phone]);
    if(!row || !await verifyPassword(password,row.password_hash))return fail(res,401,'شماره موبایل یا رمز عبور اشتباه است.');
    setSession(res,row); return res.json({ok:true,phone:row.phone});
  });
  app.post('/api/account/logout',(req,res)=>{clearCookie(res);res.json({ok:true});});
  app.get('/api/account/me',async(req,res)=>{
    const claims=account(req); if(!claims)return fail(res,401,'وارد حساب کاربری شوید.');
    const [[row]]=await db.execute('SELECT id,phone,created_at FROM web_accounts WHERE id=? LIMIT 1',[claims.id]);
    if(!row){clearCookie(res);return fail(res,401,'حساب کاربری پیدا نشد.');}
    res.json({account:row});
  });
  app.post('/api/account/forgot',async(req,res)=>{
    const phone=normalizePhone(req.body.phone);
    if(!validPhone(phone))return fail(res,400,'شماره موبایل معتبر نیست.');
    const [[row]]=await db.execute('SELECT a.id,a.phone,a.telegram_user_id,l.chat_id FROM web_accounts a JOIN account_telegram_links l ON l.telegram_user_id=a.telegram_user_id WHERE a.phone=? LIMIT 1',[phone]);
    // Always return the same public response to avoid account enumeration.
    if(row) {
      const [[pending]]=await db.execute("SELECT id FROM password_reset_requests WHERE account_id=? AND status='pending' AND created_at>DATE_SUB(NOW(),INTERVAL 15 MINUTE) LIMIT 1",[row.id]);
      if(!pending) {
        const [result]=await db.execute("INSERT INTO password_reset_requests(account_id,phone,telegram_user_id,chat_id,status) VALUES(?,?,?,?,'pending')",[row.id,row.phone,String(row.telegram_user_id),String(row.chat_id)]);
        const id=result.insertId;
        await tg('sendMessage',{chat_id:String(adminId),text:'🔐 درخواست بازیابی رمز USTORE\nشماره: '+row.phone+'\nشناسه درخواست: #'+id+'\n\nدر صورت اطمینان از هویت کاربر، تأیید کنید.',reply_markup:{inline_keyboard:[[{text:'✅ تأیید بازیابی',callback_data:'acct:a:'+id},{text:'❌ رد درخواست',callback_data:'acct:r:'+id}]]}});
        await tg('sendMessage',{chat_id:String(row.chat_id),text:'درخواست بازیابی رمز حساب USTORE ثبت شد و برای بررسی مدیر ارسال شد. اگر شما این درخواست را نداده‌اید، این پیام را نادیده بگیرید.'});
      }
    }
    return res.json({ok:true,message:'اگر حساب متصل و فعالی با این شماره وجود داشته باشد، درخواست از طریق ربات تلگرام بررسی می‌شود.'});
  });
  app.get('/api/account/reset/validate',async(req,res)=>{
    const token=String(req.query.token||'');
    if(!/^[A-Za-z0-9_-]{30,100}$/.test(token))return fail(res,400,'لینک بازیابی نامعتبر یا منقضی است.');
    const [[row]]=await db.execute('SELECT id FROM account_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW() LIMIT 1',[hash(token)]);
    if(!row)return fail(res,400,'لینک بازیابی نامعتبر یا منقضی است.');
    res.json({ok:true});
  });
  app.post('/api/account/reset',async(req,res)=>{
    const token=String(req.body.token||''),password=String(req.body.password||'');
    if(!/^[A-Za-z0-9_-]{30,100}$/.test(token))return fail(res,400,'لینک بازیابی نامعتبر یا منقضی است.');
    if(password.length<10||password.length>128)return fail(res,400,'رمز عبور باید حداقل ۱۰ و حداکثر ۱۲۸ کاراکتر باشد.');
    const conn=await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]]=await conn.execute('SELECT id,account_id FROM account_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW() FOR UPDATE',[hash(token)]);
      if(!row){await conn.rollback();return fail(res,400,'لینک بازیابی نامعتبر یا منقضی است.');}
      const nextHash=await passwordHash(password);
      await conn.execute('UPDATE web_accounts SET password_hash=?,updated_at=NOW() WHERE id=?',[nextHash,row.account_id]);
      await conn.execute('UPDATE account_reset_tokens SET used_at=NOW() WHERE id=?',[row.id]);
      await conn.execute("UPDATE password_reset_requests SET status='completed',completed_at=NOW() WHERE id=(SELECT request_id FROM account_reset_tokens WHERE id=?)",[row.id]);
      await conn.commit(); clearCookie(res); return res.json({ok:true,message:'رمز عبور با موفقیت تغییر کرد. اکنون وارد شوید.'});
    } catch(e){await conn.rollback();throw e;} finally{conn.release();}
  });
  async function handleMessage(message) {
    if(!message?.from||message.from.is_bot||message.chat?.type!=='private')return false;
    if(String(message.from.id)===String(adminId))return false;
    const text=String(message.text||'').trim();
    const start=text.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
    if(start) {
      await db.execute('INSERT INTO account_telegram_links(telegram_user_id,chat_id,username,first_name,last_seen_at) VALUES(?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id),username=VALUES(username),first_name=VALUES(first_name),last_seen_at=NOW()',[String(message.from.id),String(message.chat.id),message.from.username||null,message.from.first_name||null]);
      if(start[1]&&start[1].startsWith('link_'))return tg('sendMessage',{chat_id:String(message.chat.id),text:'حساب تلگرام شما برای بازیابی رمز USTORE آماده استفاده است. حالا به سایت برگردید و ثبت‌نام کنید.'});
    }
    return false;
  }
  async function handleCallback(q) {
    if(String(q?.from?.id)!==String(adminId)||q.message?.chat?.type!=='private')return false;
    const match=String(q.data||'').match(/^acct:([ar]):(\d+)$/);
    if(!match)return false;
    const id=Number(match[2]), approve=match[1]==='a';
    await tg('answerCallbackQuery',{callback_query_id:q.id,text:'در حال بررسی درخواست...'});
    const conn=await db.getConnection();
    let notify=null, token=null;
    try {
      await conn.beginTransaction();
      const [[request]]=await conn.execute("SELECT id,account_id,phone,telegram_user_id,chat_id,status FROM password_reset_requests WHERE id=? FOR UPDATE",[id]);
      if(!request||request.status!=='pending'){await conn.rollback();await tg('sendMessage',{chat_id:String(adminId),text:'این درخواست قبلاً بررسی شده یا وجود ندارد.'});return true;}
      if(!approve) {
        await conn.execute("UPDATE password_reset_requests SET status='rejected',reviewed_at=NOW(),reviewed_by=? WHERE id=?",[String(adminId),id]);
        notify={chat_id:String(request.chat_id),text:'درخواست بازیابی رمز حساب USTORE توسط مدیر رد شد. برای پیگیری با پشتیبانی فروشگاه تماس بگیرید.'};
      } else {
        token=randomToken();
        await conn.execute('INSERT INTO account_reset_tokens(request_id,account_id,token_hash,expires_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 15 MINUTE))',[id,request.account_id,hash(token)]);
        await conn.execute("UPDATE password_reset_requests SET status='approved',reviewed_at=NOW(),reviewed_by=? WHERE id=?",[String(adminId),id]);
        notify={chat_id:String(request.chat_id),text:'✅ درخواست بازیابی رمز شما تأیید شد. لینک امن و یک‌بارمصرف (۱۵ دقیقه):\n'+siteUrl.replace(/\/$/,'')+'/account.html?token='+encodeURIComponent(token)};
      }
      await conn.commit();
    } catch(e){await conn.rollback();throw e;} finally{conn.release();}
    if(notify)await tg('sendMessage',notify);
    await tg('editMessageReplyMarkup',{chat_id:String(q.message.chat.id),message_id:q.message.message_id,reply_markup:{inline_keyboard:[]}});
    await tg('sendMessage',{chat_id:String(adminId),text:approve?'بازیابی #'+id+' تأیید شد.':'بازیابی #'+id+' رد شد.'});
    return true;
  }
  return {handleMessage,handleCallback};
}
module.exports={createAccountAuth};
