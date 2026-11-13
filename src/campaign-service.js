'use strict';

const crypto = require('crypto');
const { makeRaffleCode, normalizePhone, validPhone, normalizeInstagram, validInstagram, validFullName } = require('./domain');

function assertInteger(value, name, min = 1, max = 10000) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(name + ' نامعتبر است.');
  return n;
}

function assertCampaignInput(input) {
  const name = String(input.name || '').trim();
  const slug = String(input.slug || '').trim().toLowerCase();
  if (name.length < 2 || name.length > 150) throw new Error('نام کمپین باید بین ۲ تا ۱۵۰ نویسه باشد.');
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) throw new Error('شناسه کمپین فقط باید شامل حروف انگلیسی، عدد و خط تیره باشد.');
  const paymentMode = input.payment_mode || 'free';
  if (!['free', 'manual', 'gateway'].includes(paymentMode)) throw new Error('روش پرداخت نامعتبر است.');
  const price = Number(input.price_per_code || 0);
  if (!Number.isFinite(price) || price < 0 || (paymentMode === 'free' && price !== 0) || (paymentMode !== 'free' && price <= 0)) {
    throw new Error('مبلغ کمپین با روش پرداخت سازگار نیست.');
  }
  return {
    name, slug, description: input.description ? String(input.description).slice(0, 5000) : null,
    paymentMode, price, currency: String(input.currency || 'IRR').toUpperCase(),
    maxParticipants: input.max_participants == null ? null : assertInteger(input.max_participants, 'ظرفیت افراد'),
    maxCodes: input.max_codes == null ? null : assertInteger(input.max_codes, 'ظرفیت کدها'),
    maxCodesPerParticipant: assertInteger(input.max_codes_per_participant || 1, 'سقف کد هر نفر', 1, 1000),
    drawBasis: input.draw_basis || 'per_code',
    winnerCount: assertInteger(input.winner_count || 1, 'تعداد برندگان'),
    alternateCount: assertInteger(input.alternate_count || 0, 'تعداد ذخیره', 0, 1000),
    multipleWinPolicy: input.multiple_win_policy || 'one_per_participant',
    drawMethod: input.draw_method || 'system',
    startsAt: input.starts_at || null, endsAt: input.ends_at || null
  };
}

function createCampaignService({ db, adminId }) {
  async function createCampaign(input) {
    const c = assertCampaignInput(input);
    if (!['per_code', 'per_participant'].includes(c.drawBasis)) throw new Error('مبنای قرعه‌کشی نامعتبر است.');
    if (!['one_per_participant', 'allow'].includes(c.multipleWinPolicy)) throw new Error('سیاست برنده‌شدن نامعتبر است.');
    if (!['system', 'live_wheel', 'hybrid'].includes(c.drawMethod)) throw new Error('روش قرعه‌کشی نامعتبر است.');
    const cardId = input.payment_card_id == null || input.payment_card_id === '' ? null : Number(input.payment_card_id);
    if (c.paymentMode === 'manual' && (!Number.isSafeInteger(cardId) || cardId < 1)) throw new Error('برای کمپین پرداخت دستی باید کارت مقصد انتخاب شود.');
    if (c.paymentMode !== 'manual' && cardId != null) throw new Error('انتخاب کارت فقط برای پرداخت دستی مجاز است.');
    const conn = await db.getConnection();
    let result;
    try {
      await conn.beginTransaction();
      if (cardId != null) {
        const [[card]] = await conn.execute("SELECT id,status FROM bank_cards WHERE id=? FOR UPDATE",[cardId]);
        if (!card || card.status !== 'active') throw new Error('کارت انتخاب‌شده فعال نیست.');
      }
      const [created] = await conn.execute(
        `INSERT INTO campaigns
        (slug,name,description,status,payment_mode,current_payment_card_id,price_per_code,currency,max_participants,max_codes,
         max_codes_per_participant,draw_basis,winner_count,alternate_count,multiple_win_policy,
         draw_method,starts_at,ends_at,created_by)
        VALUES(?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [c.slug,c.name,c.description,c.paymentMode,cardId,c.price,c.currency,c.maxParticipants,c.maxCodes,
         c.maxCodesPerParticipant,c.drawBasis,c.winnerCount,c.alternateCount,c.multipleWinPolicy,
         c.drawMethod,c.startsAt,c.endsAt,String(adminId)]
      );
      result = created;
      await conn.execute(
        "INSERT INTO campaign_status_history(campaign_id,from_status,to_status,actor,reason) VALUES(?,NULL,'draft',?,'campaign created')",
        [result.insertId,String(adminId)]
      );
      if (cardId != null) {
        await conn.execute('INSERT INTO campaign_payment_card_history(campaign_id,card_id,changed_by,change_reason) VALUES(?,?,?,?)',[result.insertId,cardId,String(adminId),'initial campaign card']);
      }
      await conn.commit();
    } catch(error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
    return { id: result.insertId, slug: c.slug };
  }

  async function updateDraftCampaign(campaignId,input) {
    const c=assertCampaignInput(input);
    if(!['per_code','per_participant'].includes(c.drawBasis))throw new Error('مبنای قرعه‌کشی نامعتبر است.');
    if(!['one_per_participant','allow'].includes(c.multipleWinPolicy))throw new Error('سیاست برنده‌شدن نامعتبر است.');
    if(!['system','live_wheel','hybrid'].includes(c.drawMethod))throw new Error('روش قرعه‌کشی نامعتبر است.');
    const cardId=input.payment_card_id==null||input.payment_card_id===''?null:Number(input.payment_card_id);
    if(c.paymentMode==='manual'&&(!Number.isSafeInteger(cardId)||cardId<1))throw new Error('برای پرداخت دستی کارت فعال لازم است.');
    if(c.paymentMode!=='manual'&&cardId!=null)throw new Error('کارت فقط برای پرداخت دستی مجاز است.');
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [[old]]=await conn.execute("SELECT id,status,current_payment_card_id FROM campaigns WHERE id=? FOR UPDATE",[campaignId]);
      if(!old||old.status!=='draft')throw new Error('فقط کمپین پیش‌نویس قابل ویرایش است.');
      if(cardId!=null){const [[card]]=await conn.execute("SELECT id,status FROM bank_cards WHERE id=? FOR UPDATE",[cardId]);if(!card||card.status!=='active')throw new Error('کارت انتخاب‌شده فعال نیست.');}
      await conn.execute(`UPDATE campaigns SET slug=?,name=?,description=?,payment_mode=?,current_payment_card_id=?,price_per_code=?,currency=?,max_participants=?,max_codes=?,max_codes_per_participant=?,draw_basis=?,winner_count=?,alternate_count=?,multiple_win_policy=?,draw_method=?,starts_at=?,ends_at=? WHERE id=? AND status='draft'`,
        [c.slug,c.name,c.description,c.paymentMode,cardId,c.price,c.currency,c.maxParticipants,c.maxCodes,c.maxCodesPerParticipant,c.drawBasis,c.winnerCount,c.alternateCount,c.multipleWinPolicy,c.drawMethod,c.startsAt,c.endsAt,campaignId]);
      if(cardId!==old.current_payment_card_id&&cardId!=null)await conn.execute('INSERT INTO campaign_payment_card_history(campaign_id,card_id,changed_by,change_reason) VALUES(?,?,?,?)',[campaignId,cardId,String(adminId),'draft edited via Telegram']);
      await conn.commit();
      return {id:campaignId,slug:c.slug};
    }catch(error){await conn.rollback();throw error;}finally{conn.release();}
  }

  async function setCampaignStatus(campaignId, nextStatus, reason = '') {
    const allowed = ['draft','scheduled','open','paused','closed','archived'];
    if (!allowed.includes(nextStatus)) throw new Error('وضعیت کمپین نامعتبر است.');
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[campaign]] = await conn.execute('SELECT id,status FROM campaigns WHERE id=? FOR UPDATE', [campaignId]);
      if (!campaign) throw new Error('کمپین پیدا نشد.');
      if (campaign.status === 'drawn' && nextStatus !== 'archived') throw new Error('کمپین قرعه‌کشی‌شده قابل بازگشایی نیست.');
      if (campaign.status === 'archived' && nextStatus !== 'archived') throw new Error('کمپین آرشیوشده قابل فعال‌سازی نیست.');
      if (nextStatus === 'open' && !['draft','scheduled','paused'].includes(campaign.status)) throw new Error('این تغییر وضعیت مجاز نیست.');
      if (nextStatus === 'closed' && !['open','paused'].includes(campaign.status)) throw new Error('فقط کمپین باز یا متوقف‌شده قابل بستن است.');
      await conn.execute('UPDATE campaigns SET status=? WHERE id=?', [nextStatus,campaignId]);
      await conn.execute(
        'INSERT INTO campaign_status_history(campaign_id,from_status,to_status,actor,reason) VALUES(?,?,?,?,?)',
        [campaignId,campaign.status,nextStatus,String(adminId),String(reason).slice(0,255)]
      );
      await conn.commit();
      return { id: campaignId, status: nextStatus };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  async function reserveManualOrder({ campaignId, participantId, quantity, termsVersion = '1', holdMinutes = 30 }) {
    const qty = assertInteger(quantity, 'تعداد کد', 1, 1000);
    const hold = assertInteger(holdMinutes, 'مدت رزرو', 5, 1440);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[campaign]] = await conn.execute('SELECT * FROM campaigns WHERE id=? FOR UPDATE', [campaignId]);
      if (!campaign || campaign.status !== 'open') throw new Error('کمپین در حال حاضر باز نیست.');
      if (campaign.payment_mode !== 'manual') throw new Error('این کمپین پرداخت دستی ندارد.');
      const [[paymentCard]] = await conn.execute("SELECT id,label,bank_name,card_number,cardholder_name,status FROM bank_cards WHERE id=? FOR UPDATE",[campaign.current_payment_card_id]);
      if (!paymentCard || paymentCard.status !== 'active') throw new Error('مدیر هنوز کارت فعال برای این کمپین انتخاب نکرده است.');
      if (qty > campaign.max_codes_per_participant) throw new Error('تعداد کد از سقف مجاز بیشتر است.');
      const [[participant]] = await conn.execute("SELECT id,status,telegram_user_id,chat_id,business_connection_id FROM participants WHERE id=? FOR UPDATE", [participantId]);
      if (!participant || participant.status !== 'active') throw new Error('پروفایل شرکت‌کننده فعال نیست.');
      const [[openOrder]] = await conn.execute(
        "SELECT id,order_ref,status,quantity,total_snapshot,currency,campaign_id FROM payment_orders WHERE participant_id=? AND status IN ('pending_payment','receipt_submitted') ORDER BY id DESC LIMIT 1 FOR UPDATE",
        [participantId]
      );
      if (openOrder?.status === 'pending_payment') {
        // Reuse only the exact logical order. Never return another campaign's
        // order or silently accept a different quantity.
        if (Number(openOrder.campaign_id) !== Number(campaignId)) {
          throw new Error('برای شما سفارش پرداخت‌نشده دیگری در کمپین «'+openOrder.order_ref+'» وجود دارد. ابتدا همان سفارش را تکمیل یا از پشتیبانی پیگیری کنید.');
        }
        if (Number(openOrder.quantity) !== qty) {
          throw new Error('برای این کمپین سفارش '+openOrder.order_ref+' با تعداد '+openOrder.quantity+' کد باز دارید. ابتدا همان سفارش را تکمیل کنید یا با پشتیبانی تماس بگیرید.');
        }
        await conn.commit();
        return { id: openOrder.id, orderRef: openOrder.order_ref, quantity: Number(openOrder.quantity), total: Number(openOrder.total_snapshot), currency: openOrder.currency, duplicate: true };
      }
      if (openOrder) throw new Error('برای شما سفارش '+openOrder.order_ref+' رسید ارسال‌شده و در انتظار بررسی دارد.');
      const [[entry]] = await conn.execute(
        'SELECT id,status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE',
        [campaignId,participantId]
      );
      const [[pending]] = await conn.execute(
        "SELECT id FROM campaign_capacity_reservations WHERE campaign_id=? AND participant_id=? AND status='held' AND expires_at>UTC_TIMESTAMP() LIMIT 1 FOR UPDATE",
        [campaignId,participantId]
      );
      if (pending) throw new Error('برای این فرد یک سفارش در انتظار پرداخت وجود دارد.');
      const [[participantUsage]] = await conn.execute(
        `SELECT
          (SELECT COUNT(*) FROM campaign_codes WHERE campaign_id=? AND participant_id=? AND status='active') +
          (SELECT COALESCE(SUM(code_slots),0) FROM campaign_capacity_reservations WHERE campaign_id=? AND participant_id=? AND status='held' AND expires_at>UTC_TIMESTAMP()) AS codes_used`,
        [campaignId,participantId,campaignId,participantId]
      );
      if (Number(participantUsage.codes_used) + qty > Number(campaign.max_codes_per_participant)) throw new Error('سقف تعداد کد مجاز برای این فرد در کمپین تکمیل می‌شود.');
      const [[capacity]] = await conn.execute(
        `SELECT
          (SELECT COUNT(DISTINCT participant_id) FROM campaign_entries WHERE campaign_id=? AND status='active') +
          (SELECT COUNT(DISTINCT r.participant_id) FROM campaign_capacity_reservations r WHERE r.campaign_id=? AND r.status='held' AND r.expires_at>UTC_TIMESTAMP() AND NOT EXISTS (SELECT 1 FROM campaign_entries e WHERE e.campaign_id=r.campaign_id AND e.participant_id=r.participant_id AND e.status='active')) AS participants_used,
          (SELECT COUNT(*) FROM campaign_codes WHERE campaign_id=? AND status='active') +
          (SELECT COALESCE(SUM(code_slots),0) FROM campaign_capacity_reservations WHERE campaign_id=? AND status='held' AND expires_at>UTC_TIMESTAMP()) AS codes_used`,
        [campaignId,campaignId,campaignId,campaignId]
      );
      const participantSlots = entry?.status === 'active' ? 0 : 1;
      if (campaign.max_participants != null && Number(capacity.participants_used) + participantSlots > Number(campaign.max_participants)) throw new Error('ظرفیت شرکت‌کنندگان کمپین تکمیل شده است.');
      if (campaign.max_codes != null && Number(capacity.codes_used) + qty > Number(campaign.max_codes)) throw new Error('ظرفیت کدهای کمپین تکمیل شده است.');
      let entryId = entry?.id;
      if (!entryId) {
        const [createdEntry] = await conn.execute(
          "INSERT INTO campaign_entries(campaign_id,participant_id,status) VALUES(?,?,'pending')",
          [campaignId,participantId]
        );
        entryId = createdEntry.insertId;
      }
      const orderRef = 'IS-' + crypto.randomBytes(9).toString('hex').toUpperCase();
      const unitPrice = Number(campaign.price_per_code);
      const total = unitPrice * qty;
      const [order] = await conn.execute(
        `INSERT INTO payment_orders(order_ref,campaign_id,participant_id,entry_id,quantity,unit_price_snapshot,total_snapshot,currency,terms_snapshot,status,expires_at)
         VALUES(?,?,?,?,?,?,?,?,?,'pending_payment',DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE))`,
        [orderRef,campaignId,participantId,entryId,qty,unitPrice,total,campaign.currency,JSON.stringify({terms_version:termsVersion,refund_policy:'no_refund_after_payment_confirmation',payment_card:{label:paymentCard.label,bank_name:paymentCard.bank_name,card_number:paymentCard.card_number,cardholder_name:paymentCard.cardholder_name}}),hold]
      );
      await conn.execute(
        "INSERT INTO campaign_capacity_reservations(campaign_id,participant_id,order_id,participant_slots,code_slots,status,expires_at) VALUES(?,?,?,?,?,'held',DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE))",
        [campaignId,participantId,order.insertId,participantSlots,qty,hold]
      );
      // Persist session and payment instructions atomically with the order.
      await conn.execute(
        "INSERT INTO campaign_payment_sessions(telegram_user_id,chat_id,business_connection_id,order_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id),business_connection_id=VALUES(business_connection_id),order_id=VALUES(order_id)",
        [String(participant.telegram_user_id),String(participant.chat_id || ''),String(participant.business_connection_id || ''),order.insertId]
      );
      if (participant.chat_id) {
        const paymentText = '🧾 سفارش شما ثبت شد.\nکمپین: '+campaign.name+'\nتعداد کد: '+qty+'\nشماره سفارش: '+orderRef+'\nمبلغ: '+total+' '+campaign.currency+'\n\nشماره کارت: '+paymentCard.card_number+'\nبه نام: '+paymentCard.cardholder_name+'\n\nپس از پرداخت، تصویر رسید را همین‌جا ارسال کنید. مهلت رزرو '+hold+' دقیقه است.';
        await conn.execute(
          "INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",
          ['payment-instructions:'+order.insertId,'payment_instructions',JSON.stringify({method:'sendMessage',payload:{chat_id:String(participant.chat_id),...(participant.business_connection_id?{business_connection_id:String(participant.business_connection_id)}:{}),text:paymentText}})]
        );
      }
      await conn.commit();
      return { id: order.insertId, orderRef, quantity: qty, total, currency: campaign.currency, card: paymentCard };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  async function submitReceipt({ orderId, fileId, fileUniqueId = null, trackingReference = null }) {
    if (!fileId) throw new Error('رسید پرداخت معتبر نیست.');
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[order]] = await conn.execute('SELECT id,status,expires_at,participant_id FROM payment_orders WHERE id=? FOR UPDATE', [orderId]);
      if (!order) throw new Error('سفارش پیدا نشد.');
      if (order.status === 'receipt_submitted') {
        const [[existingReceipt]] = await conn.execute('SELECT id,telegram_file_unique_id FROM payment_receipts WHERE order_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',[orderId]);
        if (existingReceipt && fileUniqueId && existingReceipt.telegram_file_unique_id === fileUniqueId) {
          await conn.commit();
          return { orderId, status: 'receipt_submitted', duplicate: true };
        }
        throw new Error('برای این سفارش قبلاً رسید ارسال شده و در انتظار بررسی مدیر است.');
      }
      if (order.status !== 'pending_payment') throw new Error('این سفارش در انتظار دریافت رسید نیست.');
      const [[reservation]] = await conn.execute("SELECT id,status,expires_at FROM campaign_capacity_reservations WHERE order_id=? FOR UPDATE", [orderId]);
      if (!reservation || reservation.status !== 'held' || new Date(reservation.expires_at).getTime() <= Date.now()) throw new Error('مهلت رزرو ظرفیت تمام شده است.');
      await conn.execute(
        'INSERT INTO payment_receipts(order_id,telegram_file_id,telegram_file_unique_id,declared_tracking_ref) VALUES(?,?,?,?)',
        [orderId,fileId,fileUniqueId,trackingReference]
      );
      await conn.execute("UPDATE payment_orders SET status='receipt_submitted' WHERE id=?", [orderId]);
      const [[notify]] = await conn.execute('SELECT o.order_ref,o.total_snapshot,o.currency,c.name AS campaign_name,p.full_name FROM payment_orders o JOIN campaigns c ON c.id=o.campaign_id JOIN participants p ON p.id=o.participant_id WHERE o.id=?',[orderId]);
      await conn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",['receipt-submitted:'+orderId,'payment_receipt_submitted',JSON.stringify({method:'sendMessage',payload:{chat_id:String(process.env.ADMIN_ID),text:'🧾 رسید پرداخت جدید\nسفارش: '+notify.order_ref+' (#'+orderId+')\nکمپین: '+notify.campaign_name+'\nشرکت‌کننده: '+notify.full_name+'\nمبلغ: '+notify.total_snapshot+' '+notify.currency+'\nبرای بررسی به پنل تلگرام مراجعه کنید: /panel'}})]);
      const [[recipient]] = await conn.execute('SELECT chat_id,business_connection_id FROM participants WHERE id=? LIMIT 1',[order.participant_id]);
      if (recipient?.chat_id) {
        await conn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",['receipt-ack:'+orderId,'receipt_acknowledgement',JSON.stringify({method:'sendMessage',payload:{chat_id:String(recipient.chat_id),...(recipient.business_connection_id?{business_connection_id:String(recipient.business_connection_id)}:{}),text:'✅ رسید شما دریافت شد و برای بررسی مدیر ارسال شد. پس از تأیید، کدهای قرعه‌کشی برایتان ارسال می‌شود.'}})]);
      }
      await conn.commit();
      return { orderId, status: 'receipt_submitted' };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  async function reviewManualPayment({ orderId, approve, trackingReference = null, note = '' }) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[order]] = await conn.execute('SELECT * FROM payment_orders WHERE id=? FOR UPDATE', [orderId]);
      if (!order || order.status !== 'receipt_submitted') throw new Error('سفارش رسید ارسال‌شده و قابل بررسی نیست.');
      const [[reservation]] = await conn.execute('SELECT * FROM campaign_capacity_reservations WHERE order_id=? FOR UPDATE', [orderId]);
      if (!reservation || reservation.status !== 'held') throw new Error('رزرو سفارش دیگر معتبر نیست.');
      const [[receipt]] = await conn.execute(
        "SELECT id, (submitted_at <= ?) AS submitted_in_time FROM payment_receipts WHERE order_id=? AND review_status='pending' ORDER BY submitted_at DESC LIMIT 1 FOR UPDATE",
        [order.expires_at,orderId]
      );
      if (!receipt || !receipt.submitted_in_time) throw new Error('رسید پس از پایان مهلت سفارش ارسال شده یا رسید معتبری برای بررسی وجود ندارد.');
      const [[campaign]] = await conn.execute('SELECT status FROM campaigns WHERE id=? FOR UPDATE', [order.campaign_id]);
      if (approve) {
        if (!['open','closed','paused'].includes(campaign.status)) throw new Error('وضعیت کمپین اجازه تأیید این سفارش را نمی‌دهد.');
        await conn.execute(
          "INSERT INTO payment_transactions(order_id,provider,provider_reference,amount,currency,status,verified_by) VALUES(?,'manual',?,?,?,'confirmed',?)",
          [orderId,trackingReference,order.total_snapshot,order.currency,String(adminId)]
        );
        await conn.execute("UPDATE campaign_capacity_reservations SET status='committed' WHERE id=?", [reservation.id]);
        await conn.execute("UPDATE campaign_entries SET status='active' WHERE id=?", [order.entry_id]);
        const issuedPaymentCodes = [];
        for (let i=0; i<Number(order.quantity); i++) {
          let code;
          let attempts = 0;
          while (attempts++ < 8) {
            code = makeRaffleCode();
            try {
              const [created] = await conn.execute(
                "INSERT INTO campaign_codes(campaign_id,entry_id,participant_id,code,status) VALUES(?,?,?,?,'active')",
                [order.campaign_id,order.entry_id,order.participant_id,code]
              );
              await conn.execute(
                "INSERT INTO campaign_code_history(campaign_code_id,code,action,actor,reason) VALUES(?,?,'issued',?,'manual payment approved')",
                [created.insertId,code,String(adminId)]
              );
              issuedPaymentCodes.push(code);
              break;
            } catch (error) {
              if (error.code !== 'ER_DUP_ENTRY' || attempts >= 8) throw error;
            }
          }
        }
        await conn.execute(
          "UPDATE payment_receipts SET review_status='accepted',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),review_note=? WHERE order_id=? AND review_status='pending'",
          [String(adminId),String(note).slice(0,255),orderId]
        );
        await conn.execute("UPDATE payment_orders SET status='approved',reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?", [String(adminId),orderId]);
        const [[recipient]] = await conn.execute(
          'SELECT chat_id,business_connection_id FROM participants WHERE id=? LIMIT 1',
          [order.participant_id]
        );
        if (recipient?.chat_id) {
          const issuedCodes = issuedPaymentCodes;
          await conn.execute(
            "INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",
            ['payment-approved:'+orderId,'payment_approved',JSON.stringify({
              method:'sendMessage',
              payload:{
                chat_id:String(recipient.chat_id),
                ...(recipient.business_connection_id ? {business_connection_id:String(recipient.business_connection_id)} : {}),
                text:'✅ پرداخت شما تأیید شد.\n\n🎟 کدهای قرعه‌کشی:\n'+issuedCodes.join('\n')+'\n\nاین کدها را تا پایان کمپین نگه دارید.'
              }
            })]
          );
        }
      } else {
        await conn.execute("UPDATE campaign_capacity_reservations SET status='released' WHERE id=?", [reservation.id]);
        await conn.execute("UPDATE campaign_entries SET status='cancelled' WHERE id=? AND status='pending'", [order.entry_id]);
        await conn.execute(
          "UPDATE payment_receipts SET review_status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),review_note=? WHERE order_id=? AND review_status='pending'",
          [String(adminId),String(note).slice(0,255),orderId]
        );
        await conn.execute("UPDATE payment_orders SET status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?", [String(adminId),orderId]);
        const [[recipient]] = await conn.execute('SELECT p.chat_id,p.business_connection_id FROM participants p WHERE p.id=? LIMIT 1',[order.participant_id]);
        if(recipient?.chat_id) await conn.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",['payment-rejected:'+orderId,'payment_rejected',JSON.stringify({method:'sendMessage',payload:{chat_id:String(recipient.chat_id),...(recipient.business_connection_id?{business_connection_id:String(recipient.business_connection_id)}:{}),text:'❌ رسید پرداخت سفارش شما تأیید نشد. برای پیگیری با پشتیبانی فروشگاه تماس بگیرید.'}})]);

      }
      await conn.execute(
        'INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',
        [String(adminId),approve?'approve_payment':'reject_payment','payment_order',String(orderId),JSON.stringify({tracking_reference:trackingReference,note:String(note).slice(0,255),amount:order.total_snapshot})]
      );
      await conn.commit();
      return { orderId, status: approve ? 'approved' : 'rejected' };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  async function joinFreeCampaign({ campaignId, telegramUserId, chatId, businessConnectionId = null, fullName, phone, instagram, quantity = 1 }) {
    const qty = assertInteger(quantity, 'تعداد کد', 1, 1000);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[campaign]] = await conn.execute('SELECT * FROM campaigns WHERE id=? FOR UPDATE', [campaignId]);
      if (!campaign || campaign.status !== 'open' || campaign.payment_mode !== 'free') throw new Error('کمپین رایگان در حال حاضر باز نیست.');
      const [[existingParticipant]] = await conn.execute('SELECT * FROM participants WHERE telegram_user_id=? FOR UPDATE', [String(telegramUserId)]);
      let participantId;
      if (existingParticipant) {
        if (existingParticipant.status !== 'active') throw new Error('پروفایل شما غیرفعال است؛ با پشتیبانی تماس بگیرید.');
        participantId = existingParticipant.id;
        await conn.execute('UPDATE participants SET chat_id=?,business_connection_id=? WHERE id=?', [String(chatId),businessConnectionId,participantId]);
      } else {
        const name = String(fullName || '').trim().replace(/\\s+/g, ' ');
        const normalizedPhone = normalizePhone(phone);
        const normalizedInstagram = normalizeInstagram(instagram);
        if (!validFullName(name) || !validPhone(normalizedPhone) || !validInstagram(normalizedInstagram)) throw new Error('اطلاعات پروفایل معتبر نیست.');
        const [created] = await conn.execute(
          "INSERT INTO participants(telegram_user_id,chat_id,business_connection_id,full_name,phone,instagram,status) VALUES(?,?,?,?,?,?,'active')",
          [String(telegramUserId),String(chatId),businessConnectionId,name,normalizedPhone,normalizedInstagram]
        );
        participantId = created.insertId;
      }
      const [[entry]] = await conn.execute('SELECT id,status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE', [campaignId,participantId]);
      if (entry && !['active','pending'].includes(entry.status)) throw new Error('وضعیت عضویت شما اجازه ورود مجدد به این کمپین را نمی‌دهد.');
      if (entry?.status === 'active') {
        const [existingCodes] = await conn.execute("SELECT code FROM campaign_codes WHERE campaign_id=? AND participant_id=? AND status='active' ORDER BY id ASC",[campaignId,participantId]);
        await conn.commit();
        return { participantId, entryId: entry.id, codes: existingCodes.map(row => row.code), duplicate: true };
      }
      if (qty > Number(campaign.max_codes_per_participant)) throw new Error('تعداد کد از سقف مجاز بیشتر است.');
      const [[usage]] = await conn.execute(
        'SELECT COUNT(*) AS used FROM campaign_codes WHERE campaign_id=? AND participant_id=? AND status=\'active\'',
        [campaignId,participantId]
      );
      if (Number(usage.used) + qty > Number(campaign.max_codes_per_participant)) throw new Error('سقف تعداد کد مجاز برای این فرد تکمیل شده است.');
      const [[capacity]] = await conn.execute(
        "SELECT (SELECT COUNT(DISTINCT participant_id) FROM campaign_entries WHERE campaign_id=? AND status='active') AS participants_used,(SELECT COUNT(*) FROM campaign_codes WHERE campaign_id=? AND status='active') AS codes_used",
        [campaignId,campaignId]
      );
      const participantSlots = entry?.status === 'active' ? 0 : 1;
      if (campaign.max_participants != null && Number(capacity.participants_used) + participantSlots > Number(campaign.max_participants)) throw new Error('ظرفیت شرکت‌کنندگان کمپین تکمیل شده است.');
      if (campaign.max_codes != null && Number(capacity.codes_used) + qty > Number(campaign.max_codes)) throw new Error('ظرفیت کدهای کمپین تکمیل شده است.');
      let entryId = entry?.id;
      if (!entryId) {
        const [createdEntry] = await conn.execute("INSERT INTO campaign_entries(campaign_id,participant_id,status) VALUES(?,?,'active')", [campaignId,participantId]);
        entryId = createdEntry.insertId;
      } else if (entry.status !== 'active') {
        await conn.execute("UPDATE campaign_entries SET status='active' WHERE id=?", [entryId]);
      }
      const issued = [];
      for (let i=0; i<qty; i++) {
        let inserted = false;
        for (let attempt=0; attempt<8 && !inserted; attempt++) {
          const code = makeRaffleCode();
          try {
            const [createdCode] = await conn.execute("INSERT INTO campaign_codes(campaign_id,entry_id,participant_id,code,status) VALUES(?,?,?,?,'active')", [campaignId,entryId,participantId,code]);
            await conn.execute("INSERT INTO campaign_code_history(campaign_code_id,code,action,actor,reason) VALUES(?,?,'issued','system','free campaign entry')", [createdCode.insertId,code]);
            issued.push(code);
            inserted = true;
          } catch (error) {
            if (error.code !== 'ER_DUP_ENTRY' || attempt === 7) throw error;
          }
        }
      }
      await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)', ['system','free_campaign_entry','campaign_entry',String(entryId),JSON.stringify({campaign_id:campaignId,participant_id:participantId,codes:issued})]);
      const [[recipient]] = await conn.execute('SELECT chat_id,business_connection_id FROM participants WHERE id=? LIMIT 1',[participantId]);
      if (recipient?.chat_id) {
        await conn.execute(
          "INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",
          ['free-entry:'+campaignId+':'+participantId+':'+issued.join('-'),'campaign_codes_issued',JSON.stringify({
            method:'sendMessage',
            payload:{
              chat_id:String(recipient.chat_id),
              ...(recipient.business_connection_id ? {business_connection_id:String(recipient.business_connection_id)} : {}),
              text:'🎉 ثبت‌نام شما در کمپین با موفقیت انجام شد.\n\n🎟 کدهای شما:\n'+issued.join('\n')+'\n\nموفق باشید!'
            }
          })]
        );
      }
      await conn.commit();
      return { participantId, entryId, codes: issued };
    } catch (error) {
      await conn.rollback();
      if (error.code === 'ER_DUP_ENTRY') throw new Error('شماره موبایل یا آیدی اینستاگرام قبلاً برای حساب دیگری ثبت شده است.');
      throw error;
    } finally { conn.release(); }
  }

  async function cancelManualOrder({ orderId, participantId }) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[order]] = await conn.execute(
        "SELECT id,campaign_id,entry_id,status FROM payment_orders WHERE id=? AND participant_id=? FOR UPDATE",
        [orderId,participantId]
      );
      if (!order) throw new Error('سفارش برای حساب شما پیدا نشد.');
      if (order.status === 'cancelled') {
        await conn.commit();
        return { id: orderId, status: 'cancelled', duplicate: true };
      }
      if (order.status !== 'pending_payment') throw new Error('فقط سفارش در انتظار پرداخت قابل لغو است. رسید ارسال‌شده باید توسط پشتیبانی بررسی شود.');
      await conn.execute("UPDATE payment_orders SET status='cancelled' WHERE id=? AND status='pending_payment'", [orderId]);
      await conn.execute("UPDATE campaign_capacity_reservations SET status='released' WHERE order_id=? AND status='held'", [orderId]);
      await conn.execute(
        "UPDATE campaign_entries e SET e.status='cancelled' WHERE e.id=? AND e.status='pending' AND NOT EXISTS (SELECT 1 FROM payment_orders o WHERE o.entry_id=e.id AND o.status IN ('pending_payment','receipt_submitted','approved')) AND NOT EXISTS (SELECT 1 FROM campaign_codes c WHERE c.entry_id=e.id AND c.status='active')",
        [order.entry_id]
      );
      await conn.execute("DELETE FROM campaign_payment_sessions WHERE order_id=?", [orderId]);
      await conn.execute(
        "INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)",
        ['customer:'+String(participantId),'cancel_order','payment_order',String(orderId),JSON.stringify({campaign_id:order.campaign_id})]
      );
      await conn.commit();
      return { id: orderId, status: 'cancelled' };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  async function expireReservations() {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [reservations] = await conn.execute(
        "UPDATE campaign_capacity_reservations r SET r.status='expired' WHERE r.status='held' AND r.expires_at<=UTC_TIMESTAMP() AND NOT EXISTS (SELECT 1 FROM payment_orders o WHERE o.id=r.order_id AND o.status='receipt_submitted')"
      );
      const [orders] = await conn.execute(
        "UPDATE payment_orders o JOIN campaign_capacity_reservations r ON r.order_id=o.id SET o.status='expired' WHERE r.status='expired' AND o.status='pending_payment' AND o.expires_at<=UTC_TIMESTAMP()"
      );
      await conn.execute(
        "UPDATE campaign_entries e SET e.status='cancelled' WHERE e.status='pending' AND NOT EXISTS (SELECT 1 FROM payment_orders o WHERE o.entry_id=e.id AND o.status IN ('pending_payment','receipt_submitted','approved')) AND NOT EXISTS (SELECT 1 FROM campaign_codes c WHERE c.entry_id=e.id AND c.status='active')"
      );
      await conn.commit();
      return { reservationsExpired: reservations.affectedRows, ordersExpired: orders.affectedRows };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  async function requestProfileChange({ participantId, field, value }) {
    const fields = {
      full_name: v => { const x=String(v||'').trim().replace(/\\s+/g,' '); if(!validFullName(x)) throw new Error('نام معتبر نیست.'); return x; },
      phone: v => { const x=normalizePhone(v); if(!validPhone(x)) throw new Error('شماره موبایل معتبر نیست.'); return x; },
      instagram: v => { const x=normalizeInstagram(v); if(!validInstagram(x)) throw new Error('آیدی اینستاگرام معتبر نیست.'); return x; }
    };
    if (!fields[field]) throw new Error('فیلد قابل اصلاح نیست.');
    const nextValue = fields[field](value);
    const [[participant]] = await db.execute(`SELECT id,${field} AS old_value FROM participants WHERE id=? AND status='active' LIMIT 1`, [participantId]);
    if (!participant) throw new Error('پروفایل فعال پیدا نشد.');
    if (String(participant.old_value) === nextValue) throw new Error('مقدار جدید با مقدار فعلی یکسان است.');
    const [result] = await db.execute("INSERT INTO profile_change_requests(participant_id,field_name,old_value,requested_value,status) VALUES(?,?,?,?,'pending')", [participantId,field,String(participant.old_value),nextValue]);
    const [[recipient]]=await db.execute('SELECT chat_id FROM participants WHERE id=? LIMIT 1',[participantId]);
    if(recipient?.chat_id) await db.execute("INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",['profile-change:'+result.insertId,'profile_change_requested',JSON.stringify({method:'sendMessage',payload:{chat_id:String(adminId),text:'📝 درخواست اصلاح پروفایل جدید\nشناسه: '+result.insertId+'\nشرکت‌کننده: '+participantId+'\nفیلد: '+field+'\nمقدار قبلی: '+participant.old_value+'\nمقدار درخواستی: '+nextValue+'\nبرای بررسی به پنل تلگرام بروید: /panel'}})]);

    return { id: result.insertId, status: 'pending' };
  }

  async function reviewProfileChange({ requestId, approve, note = '' }) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[request]] = await conn.execute('SELECT * FROM profile_change_requests WHERE id=? FOR UPDATE', [requestId]);
      if (!request || request.status !== 'pending') throw new Error('درخواست اصلاح پیدا نشد یا قبلاً بررسی شده است.');
      const [[participant]] = await conn.execute('SELECT id,status,chat_id,business_connection_id FROM participants WHERE id=? FOR UPDATE', [request.participant_id]);
      if (!participant || participant.status !== 'active') throw new Error('پروفایل فعال نیست.');
      if (approve) {
        const allowed = new Set(['full_name','phone','instagram']);
        if (!allowed.has(request.field_name)) throw new Error('فیلد درخواست نامعتبر است.');
        await conn.execute(`UPDATE participants SET ${request.field_name}=? WHERE id=?`, [request.requested_value,request.participant_id]);
      }
      await conn.execute("UPDATE profile_change_requests SET status=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),review_note=? WHERE id=?", [approve?'approved':'rejected',String(adminId),String(note).slice(0,255),requestId]);
      await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)', [String(adminId),approve?'approve_profile_change':'reject_profile_change','profile_change_request',String(requestId),JSON.stringify({participant_id:request.participant_id,field:request.field_name,old_value:request.old_value,new_value:request.requested_value,note})]);
      if (participant.chat_id) {
        const statusText = approve ? 'تأیید شد و اطلاعات شما به‌روزرسانی شد.' : 'رد شد. برای پیگیری با پشتیبانی USTORE تماس بگیرید.';
        await conn.execute(
          "INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",
          ['profile-change-reviewed:'+requestId,'profile_change_reviewed',JSON.stringify({
            method:'sendMessage',
            payload:{
              chat_id:String(participant.chat_id),
              ...(participant.business_connection_id ? {business_connection_id:String(participant.business_connection_id)} : {}),
              text:'📋 نتیجه درخواست اصلاح پروفایل #'+requestId+'\n'+statusText
            }
          })]
        );
      }
      await conn.commit();
      return { id: requestId, status: approve?'approved':'rejected' };
    } catch (error) {
      await conn.rollback();
      if (error.code === 'ER_DUP_ENTRY') throw new Error('شماره یا آیدی اینستاگرام جدید قبلاً برای فرد دیگری ثبت شده است.');
      throw error;
    } finally { conn.release(); }
  }

  return { createCampaign, updateDraftCampaign, setCampaignStatus, reserveManualOrder, cancelManualOrder, submitReceipt, reviewManualPayment, joinFreeCampaign, expireReservations, requestProfileChange, reviewProfileChange };
}

module.exports = { createCampaignService, assertCampaignInput };
