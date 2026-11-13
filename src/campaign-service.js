'use strict';

const crypto = require('crypto');
const { makeRaffleCode } = require('./domain');

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
    maxCodesPerParticipant: assertInteger(input.max_codes_per_participant || 1, 'سقف کد هر نفر'),
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
    const [result] = await db.execute(
      `INSERT INTO campaigns
      (slug,name,description,status,payment_mode,price_per_code,currency,max_participants,max_codes,
       max_codes_per_participant,draw_basis,winner_count,alternate_count,multiple_win_policy,
       draw_method,starts_at,ends_at,created_by)
      VALUES(?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.slug,c.name,c.description,c.paymentMode,c.price,c.currency,c.maxParticipants,c.maxCodes,
       c.maxCodesPerParticipant,c.drawBasis,c.winnerCount,c.alternateCount,c.multipleWinPolicy,
       c.drawMethod,c.startsAt,c.endsAt,String(adminId)]
    );
    await db.execute(
      "INSERT INTO campaign_status_history(campaign_id,from_status,to_status,actor,reason) VALUES(?,NULL,'draft',?,'campaign created')",
      [result.insertId,String(adminId)]
    );
    return { id: result.insertId, slug: c.slug };
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
      if (qty > campaign.max_codes_per_participant) throw new Error('تعداد کد از سقف مجاز بیشتر است.');
      const [[participant]] = await conn.execute("SELECT id,status FROM participants WHERE id=? FOR UPDATE", [participantId]);
      if (!participant || participant.status !== 'active') throw new Error('پروفایل شرکت‌کننده فعال نیست.');
      const [[entry]] = await conn.execute(
        'SELECT id,status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE',
        [campaignId,participantId]
      );
      if (entry?.status === 'active') throw new Error('این فرد قبلاً در کمپین شرکت کرده است.');
      const [[pending]] = await conn.execute(
        "SELECT id FROM campaign_capacity_reservations WHERE campaign_id=? AND participant_id=? AND status='held' AND expires_at>UTC_TIMESTAMP() LIMIT 1 FOR UPDATE",
        [campaignId,participantId]
      );
      if (pending) throw new Error('برای این فرد یک سفارش در انتظار پرداخت وجود دارد.');
      const [[capacity]] = await conn.execute(
        `SELECT
          (SELECT COUNT(DISTINCT participant_id) FROM campaign_entries WHERE campaign_id=? AND status='active') +
          (SELECT COUNT(DISTINCT participant_id) FROM campaign_capacity_reservations WHERE campaign_id=? AND status='held' AND expires_at>UTC_TIMESTAMP()) AS participants_used,
          (SELECT COUNT(*) FROM campaign_codes WHERE campaign_id=? AND status='active') +
          (SELECT COALESCE(SUM(code_slots),0) FROM campaign_capacity_reservations WHERE campaign_id=? AND status='held' AND expires_at>UTC_TIMESTAMP()) AS codes_used`,
        [campaignId,campaignId,campaignId,campaignId]
      );
      if (campaign.max_participants != null && Number(capacity.participants_used) + 1 > Number(campaign.max_participants)) throw new Error('ظرفیت شرکت‌کنندگان کمپین تکمیل شده است.');
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
        [orderRef,campaignId,participantId,entryId,qty,unitPrice,total,campaign.currency,JSON.stringify({terms_version:termsVersion,refund_policy:'no_refund_after_payment_confirmation'}),hold]
      );
      await conn.execute(
        "INSERT INTO campaign_capacity_reservations(campaign_id,participant_id,order_id,participant_slots,code_slots,status,expires_at) VALUES(?,?,?,1,?,'held',DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE))",
        [campaignId,participantId,order.insertId,qty,hold]
      );
      await conn.commit();
      return { id: order.insertId, orderRef, quantity: qty, total, currency: campaign.currency };
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
      const [[order]] = await conn.execute('SELECT id,status,expires_at FROM payment_orders WHERE id=? FOR UPDATE', [orderId]);
      if (!order || order.status !== 'pending_payment') throw new Error('این سفارش در انتظار دریافت رسید نیست.');
      const [[reservation]] = await conn.execute("SELECT id,status,expires_at FROM campaign_capacity_reservations WHERE order_id=? FOR UPDATE", [orderId]);
      if (!reservation || reservation.status !== 'held' || new Date(reservation.expires_at).getTime() <= Date.now()) throw new Error('مهلت رزرو ظرفیت تمام شده است.');
      await conn.execute(
        'INSERT INTO payment_receipts(order_id,telegram_file_id,telegram_file_unique_id,declared_tracking_ref) VALUES(?,?,?,?)',
        [orderId,fileId,fileUniqueId,trackingReference]
      );
      await conn.execute("UPDATE payment_orders SET status='receipt_submitted' WHERE id=?", [orderId]);
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
      if (!reservation || reservation.status !== 'held' || new Date(reservation.expires_at).getTime() <= Date.now()) throw new Error('رزرو سفارش منقضی شده است.');
      const [[campaign]] = await conn.execute('SELECT status FROM campaigns WHERE id=? FOR UPDATE', [order.campaign_id]);
      if (approve) {
        if (!['open','closed','paused'].includes(campaign.status)) throw new Error('وضعیت کمپین اجازه تأیید این سفارش را نمی‌دهد.');
        await conn.execute(
          "INSERT INTO payment_transactions(order_id,provider,provider_reference,amount,currency,status,verified_by) VALUES(?,'manual',?,?,?,'confirmed',?)",
          [orderId,trackingReference,order.total_snapshot,order.currency,String(adminId)]
        );
        await conn.execute("UPDATE campaign_capacity_reservations SET status='committed' WHERE id=?", [reservation.id]);
        await conn.execute("UPDATE campaign_entries SET status='active' WHERE id=?", [order.entry_id]);
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
        await conn.execute(
          "INSERT IGNORE INTO telegram_notification_outbox(dedupe_key,notification_type,payload) VALUES(?,?,?)",
          ['payment-approved:'+orderId,'payment_approved',JSON.stringify({order_id:orderId,participant_id:order.participant_id})]
        );
      } else {
        await conn.execute("UPDATE campaign_capacity_reservations SET status='released' WHERE id=?", [reservation.id]);
        await conn.execute("UPDATE campaign_entries SET status='cancelled' WHERE id=? AND status='pending'", [order.entry_id]);
        await conn.execute(
          "UPDATE payment_receipts SET review_status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),review_note=? WHERE order_id=? AND review_status='pending'",
          [String(adminId),String(note).slice(0,255),orderId]
        );
        await conn.execute("UPDATE payment_orders SET status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?", [String(adminId),orderId]);
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

  return { createCampaign, setCampaignStatus, reserveManualOrder, submitReceipt, reviewManualPayment };
}

module.exports = { createCampaignService, assertCampaignInput };
