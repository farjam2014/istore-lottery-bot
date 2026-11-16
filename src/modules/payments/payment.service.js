import {randomBytes} from 'node:crypto';
import {issueCampaignCodes} from '../entries/campaign-code.js';
import {pool} from '../../database/pool.js';
import {enqueueTelegramNotification} from '../notifications/outbox.service.js';
import {getCorrelationId} from '../../shared/request-context.js';
import {getDefaultPaymentCard,createPaymentCard,updatePaymentCard} from './bank-card.service.js';
import {normalizeAdminIds} from './admin-recipients.js';
export async function getPaymentSettings(){return getDefaultPaymentCard();}
export async function updatePaymentSettings({bankName,cardNumber,cardHolder,instructions,adminId}){const current=await getDefaultPaymentCard();if(current)return updatePaymentCard(current.id,{bankName,cardNumber,cardHolder,instructions},adminId);return createPaymentCard({bankName,cardNumber,cardHolder,instructions},adminId);}
const makePaymentReference=()=> 'ISTPAY-'+randomBytes(8).toString('hex').toUpperCase();
export async function createOrGetOrder({telegramUserId,campaignId}){
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[campaign]]=await c.execute(
      'SELECT id,title,status,participation_type,entry_price,starts_at,ends_at,capacity,(starts_at IS NOT NULL AND starts_at>UTC_TIMESTAMP()) AS not_started,(ends_at IS NOT NULL AND ends_at<=UTC_TIMESTAMP()) AS already_ended FROM campaigns WHERE id=? FOR UPDATE',
      [campaignId]
    );
    if(!campaign||campaign.status!=='open'||campaign.participation_type!=='paid'||Number(campaign.entry_price)<1)throw Error('کمپین پولی در حال حاضر قابل سفارش نیست.');

    const [[participant]]=await c.execute(
      "SELECT * FROM participants WHERE telegram_user_id=? AND status='active' FOR UPDATE",
      [String(telegramUserId)]
    );
    if(!participant)throw Error('حساب کاربری فعال پیدا نشد.');
    if(Number(campaign.not_started)===1)throw Error('زمان شروع کمپین هنوز نرسیده است.');
    if(Number(campaign.already_ended)===1)throw Error('مهلت کمپین تمام شده است.');

    const [[entry]]=await c.execute(
      'SELECT id,status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE',
      [campaignId,participant.id]
    );
    if(entry?.status==='eligible'){
      await c.commit();
      return {paid:true};
    }

    let entryId=entry?.id;
    if(!entry){
      if(campaign.capacity!==null){
        const [[count]]=await c.execute(
          "SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",
          [campaignId]
        );
        if(Number(count.total)>=Number(campaign.capacity))throw Error('ظرفیت کمپین تکمیل شده است.');
      }
      const snapshot={
        telegram_user_id:String(participant.telegram_user_id),
        telegram_username:participant.telegram_username,
        full_name:participant.full_name,
        phone:participant.phone,
        instagram_handle:participant.instagram_handle
      };
      const [created]=await c.execute(
        "INSERT INTO campaign_entries(campaign_id,participant_id,profile_snapshot,status) VALUES(?,?,?,'pending_payment')",
        [campaignId,participant.id,JSON.stringify(snapshot)]
      );
      entryId=created.insertId;
    }else if(entry.status==='cancelled'){
      if(campaign.capacity!==null){
        const [[count]]=await c.execute(
          "SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",
          [campaignId]
        );
        if(Number(count.total)>=Number(campaign.capacity))throw Error('ظرفیت کمپین تکمیل شده است.');
      }
      await c.execute("UPDATE campaign_entries SET status='pending_payment' WHERE id=?",[entryId]);
    }else if(entry.status!=='pending_payment'){
      throw Error('وضعیت شرکت‌کننده اجازه سفارش نمی‌دهد.');
    }

    let [[order]]=await c.execute(
      'SELECT id,payment_reference,amount,currency,status,expires_at,(expires_at IS NOT NULL AND expires_at<=UTC_TIMESTAMP()) AS is_expired,bank_name,card_number,card_holder,payment_instructions FROM payment_orders WHERE campaign_entry_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [entryId]
    );

    let reissueExpiredOrder=false;
    if(order&&Number(order.is_expired)===1&&['awaiting_receipt','rejected'].includes(order.status)){
      await c.execute("UPDATE payment_orders SET status='expired' WHERE id=? AND status IN ('awaiting_receipt','rejected')",[order.id]);
      await c.execute("UPDATE campaign_entries SET status='cancelled' WHERE id=? AND status='pending_payment'",[entryId]);
      order={...order,status:'expired'};
      reissueExpiredOrder=true;
    }else if(order?.status==='expired'){
      reissueExpiredOrder=true;
    }

    if(order&&['under_review','approved','cancelled'].includes(order.status)){
      throw Error('این سفارش در وضعیت فعلی قابل ارسال رسید نیست.');
    }
    if(order&&order.status!=='expired'&&!['awaiting_receipt','rejected'].includes(order.status)){
      throw Error('وضعیت سفارش اجازه ادامه پرداخت نمی‌دهد.');
    }

    if(!order||reissueExpiredOrder){
      const card=await getDefaultPaymentCard(c,{lock:true});
      if(!card)throw Error('اطلاعات واریز هنوز توسط مدیریت ثبت نشده است.');

      const [[latestEntry]]=await c.execute('SELECT status FROM campaign_entries WHERE id=? FOR UPDATE',[entryId]);
      if(latestEntry?.status==='cancelled'){
        if(campaign.capacity!==null){
          const [[count]]=await c.execute(
            "SELECT COUNT(*) total FROM campaign_entries WHERE campaign_id=? AND status IN ('eligible','pending_payment')",
            [campaignId]
          );
          if(Number(count.total)>=Number(campaign.capacity))throw Error('ظرفیت کمپین تکمیل شده است.');
        }
        await c.execute("UPDATE campaign_entries SET status='pending_payment' WHERE id=?",[entryId]);
      }

      const reference=makePaymentReference();
      if(order){
        const previous={
          paymentReference:order.payment_reference,
          status:order.status,
          expiresAt:order.expires_at,
          cardLast4:String(order.card_number||'').slice(-4)
        };
        const [updated]=await c.execute(
          "UPDATE payment_orders SET payment_reference=?,amount=?,currency='IRR',status='awaiting_receipt',expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 24 HOUR),bank_name=?,card_number=?,card_holder=?,payment_instructions=?,rejection_reason=NULL,approved_by=NULL,approved_at=NULL WHERE id=? AND status='expired'",
          [reference,campaign.entry_price,card.bank_name,card.card_number,card.card_holder,card.instructions,order.id]
        );
        if(Number(updated.affectedRows)!==1)throw Error('سفارش منقضی‌شده هم‌زمان تغییر کرده است؛ دوباره تلاش کنید.');
        await c.execute(
          'INSERT INTO payment_events(order_id,actor_telegram_id,correlation_id,event_type,details) VALUES(?,?,?,?,?)',
          [order.id,String(telegramUserId),getCorrelationId(),'order_reissued',JSON.stringify({
            previous,
            newPaymentReference:reference,
            amount:campaign.entry_price,
            currency:'IRR',
            cardLast4:String(card.card_number||'').slice(-4)
          })]
        );
        order={
          id:order.id,
          payment_reference:reference,
          amount:campaign.entry_price,
          currency:'IRR',
          status:'awaiting_receipt',
          bank_name:card.bank_name,
          card_number:card.card_number,
          card_holder:card.card_holder,
          payment_instructions:card.instructions
        };
      }else{
        const [created]=await c.execute(
          "INSERT INTO payment_orders(campaign_entry_id,payment_reference,amount,currency,status,expires_at,bank_name,card_number,card_holder,payment_instructions) VALUES(?, ?,?,'IRR','awaiting_receipt',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 24 HOUR),?,?,?,?)",
          [entryId,reference,campaign.entry_price,card.bank_name,card.card_number,card.card_holder,card.instructions]
        );
        order={
          id:created.insertId,
          payment_reference:reference,
          amount:campaign.entry_price,
          currency:'IRR',
          status:'awaiting_receipt',
          bank_name:card.bank_name,
          card_number:card.card_number,
          card_holder:card.card_holder,
          payment_instructions:card.instructions
        };
      }
    }

    await c.commit();
    return {paid:false,order,campaignTitle:campaign.title};
  }catch(error){
    try{await c.rollback();}catch{}
    throw error;
  }finally{
    c.release();
  }
}
export async function submitReceipt({telegramUserId,orderId,fileId,fileUniqueId,note='',adminIds=[]}){const c=await pool.getConnection();try{await c.beginTransaction();const [[o]]=await c.execute('SELECT o.id,o.status,o.expires_at,(o.expires_at IS NOT NULL AND o.expires_at<=UTC_TIMESTAMP()) AS is_expired,o.payment_reference,o.amount,c.title campaign_title,p.telegram_user_id,p.full_name,p.phone,p.instagram_handle FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id JOIN participants p ON p.id=e.participant_id WHERE o.id=? FOR UPDATE',[orderId]);if(!o||String(o.telegram_user_id)!==String(telegramUserId))throw Error('سفارش معتبر پیدا نشد.');const [d]=await c.execute('SELECT id FROM payment_receipts WHERE telegram_file_unique_id=?',[String(fileUniqueId)]);if(d.length)throw Error('این تصویر رسید قبلاً ارسال شده است.');if(!['awaiting_receipt','rejected'].includes(o.status))throw Error('این سفارش در وضعیت ارسال رسید نیست.');if(Number(o.is_expired)===1)throw Error('مهلت سفارش تمام شده است؛ با پشتیبانی تماس بگیرید.');const [r]=await c.execute("INSERT INTO payment_receipts(order_id,telegram_file_id,telegram_file_unique_id,note,status) VALUES(?,?,?,?,'submitted')",[orderId,fileId,String(fileUniqueId),String(note).slice(0,500)]);await c.execute("UPDATE payment_orders SET status='under_review' WHERE id=?",[orderId]);await c.execute('INSERT INTO payment_events(order_id,actor_telegram_id,correlation_id,event_type,details) VALUES(?,?,?,?,?)',[orderId,String(telegramUserId),getCorrelationId(),'receipt_submitted',JSON.stringify({receiptId:r.insertId})]);const [financeAdmins]=await c.execute("SELECT telegram_user_id FROM admin_users WHERE is_active=1 AND role IN ('super_admin','finance_manager')");const recipients=new Set([...normalizeAdminIds(adminIds),...financeAdmins.map(x=>String(x.telegram_user_id))]);const caption='رسید #'+r.insertId+' | سفارش #'+orderId+'\nشناسه پرداخت: '+o.payment_reference+'\nکمپین: '+o.campaign_title+'\nمبلغ: '+Number(o.amount||0).toLocaleString('fa-IR')+' ریال\nکاربر: '+(o.full_name||'—')+'\nموبایل: '+(o.phone||'—')+'\nاینستاگرام: '+(o.instagram_handle?'@'+o.instagram_handle:'—')+'\nیادداشت: '+(String(note||'').trim()||'—');for(const chatId of recipients)await enqueueTelegramNotification({chatId,text:'رسید جدید برای سفارش #'+orderId+' دریافت شد.',photo:fileId,caption,options:{reply_markup:{inline_keyboard:[[{text:'تأیید پرداخت',callback_data:'payment:approve:'+r.insertId}],[{text:'رد رسید',callback_data:'payment:reject:'+r.insertId}]]}},executor:c});await c.commit();return {receiptId:r.insertId,adminNotificationsQueued:recipients.size};}catch(e){await c.rollback();if(e.code==='ER_DUP_ENTRY')throw Error('این رسید قبلاً ثبت شده است.');throw e;}finally{c.release();}}
export async function listPendingReceipts(){const [r]=await pool.execute("SELECT pr.id receipt_id,pr.order_id,pr.telegram_file_id,pr.note,o.payment_reference,o.amount,c.title campaign_title,p.telegram_user_id,p.full_name,p.phone,p.instagram_handle FROM payment_receipts pr JOIN payment_orders o ON o.id=pr.order_id JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id JOIN participants p ON p.id=e.participant_id WHERE pr.status='submitted' AND o.status='under_review' ORDER BY pr.created_at LIMIT 30");return r;}
export async function reviewReceipt({adminId,receiptId,decision,reason=''}){if(!['approve','reject'].includes(decision))throw Error('تصمیم نامعتبر است.');if(decision==='reject'&&!String(reason).trim())throw Error('دلیل رد رسید الزامی است.');const c=await pool.getConnection();try{await c.beginTransaction();const [[r]]=await c.execute("SELECT pr.id receipt_id,pr.order_id,pr.status receipt_status,o.status order_status,o.campaign_entry_id,e.campaign_id,e.status entry_status,ca.codes_per_entry FROM payment_receipts pr JOIN payment_orders o ON o.id=pr.order_id JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns ca ON ca.id=e.campaign_id WHERE pr.id=? FOR UPDATE",[receiptId]);if(!r||r.receipt_status!=='submitted'||r.order_status!=='under_review')throw Error('این رسید قبلاً بررسی شده یا در صف بررسی نیست.');if(decision==='approve'){if(r.entry_status!=='pending_payment')throw Error('وضعیت ورودی با تأیید پرداخت سازگار نیست.');await c.execute("UPDATE payment_receipts SET status='approved',reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?",[String(adminId),receiptId]);await c.execute("UPDATE payment_receipts SET status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),review_note='رسید دیگری برای این سفارش تأیید شد' WHERE order_id=? AND id<>? AND status='submitted'",[String(adminId),r.order_id,receiptId]);await c.execute("UPDATE payment_orders SET status='approved',approved_by=?,approved_at=UTC_TIMESTAMP(),rejection_reason=NULL WHERE id=?",[String(adminId),r.order_id]);await c.execute("UPDATE campaign_entries SET status='eligible' WHERE id=?",[r.campaign_entry_id]);const [[n]]=await c.execute('SELECT COUNT(*) total FROM campaign_codes WHERE campaign_entry_id=?',[r.campaign_entry_id]);const target=Math.max(1,Math.min(100,Number(r.codes_per_entry)||1));if(Number(n.total)<target)await issueCampaignCodes(c,{entryId:r.campaign_entry_id,campaignId:r.campaign_id,requested:target-Number(n.total)});}else{await c.execute("UPDATE payment_receipts SET status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),review_note=? WHERE id=?",[String(adminId),String(reason).trim().slice(0,500),receiptId]);await c.execute("UPDATE payment_orders SET status='rejected',rejection_reason=?,expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 24 HOUR) WHERE id=?",[String(reason).trim().slice(0,500),r.order_id]);}await c.execute('INSERT INTO payment_events(order_id,actor_telegram_id,event_type,details) VALUES(?,?,?,?)',[r.order_id,String(adminId),decision==='approve'?'payment_approved':'payment_rejected',JSON.stringify({receiptId,reason})]);await c.execute('INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',[String(adminId),getCorrelationId(),decision==='approve'?'payment.approved':'payment.rejected','payment_order',r.order_id,JSON.stringify({receiptId,reason})]);const [[owner]]=await c.execute('SELECT p.telegram_user_id FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN participants p ON p.id=e.participant_id WHERE o.id=?',[r.order_id]);let notificationText;if(decision==='approve'){const [issued]=await c.execute('SELECT code FROM campaign_codes WHERE campaign_entry_id=? ORDER BY id',[r.campaign_entry_id]);notificationText='پرداخت سفارش #'+r.order_id+' تأیید شد.\nکدهای شرکت شما:\n'+issued.map(x=>x.code).join('\n');}else{notificationText='رسید پرداخت سفارش #'+r.order_id+' رد شد.\nدلیل: '+String(reason).trim().slice(0,500)+'\nدر صورت امکان، رسید صحیح را دوباره ارسال کنید.';}await c.execute("INSERT INTO telegram_notification_outbox(chat_id,correlation_id,payload,status) VALUES(?,?,?,'pending')",[String(owner.telegram_user_id),getCorrelationId(),JSON.stringify({text:notificationText})]);await c.commit();return {orderId:r.order_id,entryId:r.campaign_entry_id,telegramUserId:String(owner.telegram_user_id)};}catch(e){await c.rollback();throw e;}finally{c.release();}}
export async function expirePendingOrders({limit=100}={}){const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT o.id,o.campaign_entry_id,p.telegram_user_id FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN participants p ON p.id=e.participant_id WHERE o.status IN ('awaiting_receipt','rejected') AND o.expires_at<=UTC_TIMESTAMP() ORDER BY o.expires_at LIMIT ? FOR UPDATE SKIP LOCKED",[Math.max(1,Math.min(500,Number(limit)||100))]);for(const row of rows){await c.execute("UPDATE payment_orders SET status='expired' WHERE id=? AND status IN ('awaiting_receipt','rejected')",[row.id]);await c.execute("UPDATE campaign_entries SET status='cancelled' WHERE id=? AND status='pending_payment'",[row.campaign_entry_id]);await c.execute("INSERT INTO payment_events(order_id,actor_telegram_id,event_type,details) VALUES(?,0,'order_expired',JSON_OBJECT('reason','24h timeout'))",[row.id]);await c.execute("INSERT INTO telegram_notification_outbox(chat_id,payload,status) VALUES(?,?,'pending')",[String(row.telegram_user_id),JSON.stringify({text:'مهلت ۲۴ ساعته سفارش شما به پایان رسید و ظرفیت رزروشده آزاد شد. در صورت بازبودن کمپین می‌توانید دوباره اقدام کنید.'})]);}await c.commit();return rows.length;}catch(error){await c.rollback();throw error;}finally{c.release();}}
export async function listUserOrders(uid){const [r]=await pool.execute("SELECT o.id,o.payment_reference,o.amount,o.currency,o.status,o.created_at,o.expires_at,o.rejection_reason,c.title campaign_title FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id JOIN participants p ON p.id=e.participant_id WHERE p.telegram_user_id=? ORDER BY o.id DESC LIMIT 20",[String(uid)]);return r;}
export async function getUserOrder(id,uid){const [r]=await pool.execute('SELECT o.id,o.amount,o.status,o.expires_at,(o.expires_at IS NOT NULL AND o.expires_at<=UTC_TIMESTAMP()) AS is_expired,o.card_number,o.card_holder FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN participants p ON p.id=e.participant_id WHERE o.id=? AND p.telegram_user_id=?',[id,String(uid)]);return r[0]??null;}

export async function recordPaymentCardDelivery({telegramUserId,orderId}){
  const [[order]]=await pool.execute(
    'SELECT o.id,o.bank_name,o.card_number,o.card_holder,p.telegram_user_id FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN participants p ON p.id=e.participant_id WHERE o.id=?',
    [orderId]
  );
  if(!order||String(order.telegram_user_id)!==String(telegramUserId))throw new Error('سفارش معتبر برای ثبت تاریخچه اطلاعات کارت پیدا نشد.');
  await pool.execute(
    'INSERT INTO payment_events(order_id,actor_telegram_id,correlation_id,event_type,details) VALUES(?,?,?,?,?)',
    [orderId,String(telegramUserId),getCorrelationId(),'bank_details_presented',JSON.stringify({
      bankName:order.bank_name,
      cardLast4:String(order.card_number||'').slice(-4),
      cardHolder:order.card_holder
    })]
  );
}
