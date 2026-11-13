'use strict';
const crypto = require('node:crypto');
const { validFullName, validPhone, validInstagram } = require('./domain');

function makeCampaignCode(campaignId, sequence, secret) {
  if (!secret || String(secret).length < 32) throw new Error('CAMPAIGN_CODE_SECRET must contain at least 32 characters');
  const digest = crypto.createHmac('sha256', secret)
    .update(String(campaignId) + ':' + String(sequence))
    .digest('hex').toUpperCase();
  return 'IS-' + digest.slice(0, 24);
}

/**
 * Creates at most one entry per Telegram identity and campaign.
 * Manual/provider payments deliberately remain pending and receive no code.
 * Provider payment confirmation must be implemented as a separately authenticated webhook.
 */
async function issueCodeInTransaction(conn, campaignId, entryId, codeSecret) {
  await conn.execute('INSERT IGNORE INTO campaign_sequences(campaign_id,last_sequence) VALUES(?,0)', [campaignId]);
  const [[sequenceRow]] = await conn.execute(
    'SELECT last_sequence FROM campaign_sequences WHERE campaign_id=? FOR UPDATE', [campaignId]
  );
  const sequence = Number(sequenceRow.last_sequence) + 1;
  await conn.execute('UPDATE campaign_sequences SET last_sequence=? WHERE campaign_id=?', [sequence, campaignId]);
  const code = makeCampaignCode(campaignId, sequence, codeSecret);
  await conn.execute(
    "INSERT INTO issued_codes(campaign_id,entry_id,sequence_no,code,status) VALUES(?,?,?,?, 'active')",
    [campaignId, entryId, sequence, code]
  );
  return code;
}

async function joinCampaign({ db, telegramUserId, fullName, phone, instagram, chatId, campaignSlug, codeSecret }) {
  if (!telegramUserId || !campaignSlug) throw new Error('telegramUserId and campaignSlug are required');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[campaign]] = await conn.execute(
      `SELECT * FROM campaigns
       WHERE slug=? AND status='active'
         AND (starts_at IS NULL OR starts_at<=NOW())
         AND (ends_at IS NULL OR ends_at>=NOW())
       FOR UPDATE`, [campaignSlug]
    );
    if (!campaign) throw Object.assign(new Error('CAMPAIGN_NOT_OPEN'), { code: 'CAMPAIGN_NOT_OPEN' });
    if (!validFullName(fullName) || !validPhone(phone) || !validInstagram(instagram)) {
      throw Object.assign(new Error('INVALID_PARTICIPANT_PROFILE'), { code: 'INVALID_PARTICIPANT_PROFILE' });
    }

    // One real person must not enter an active campaign through multiple Telegram accounts.
    // Check before the profile upsert so a rejected update cannot overwrite an existing profile.
    const [[duplicate]] = await conn.execute(
      `SELECT p.id
       FROM participants p
       JOIN campaign_entries e ON e.participant_id=p.id
       JOIN campaigns c ON c.id=e.campaign_id
       WHERE p.telegram_user_id<>?
         AND e.status IN ('active','pending_payment')
         AND c.status='active'
         AND (p.phone=? OR p.instagram=?)
       LIMIT 1 FOR UPDATE`,
      [String(telegramUserId), phone, instagram]
    );
    if (duplicate) throw Object.assign(new Error('DUPLICATE_CONTACT'), { code: 'DUPLICATE_CONTACT' });

    await conn.execute(
      `INSERT INTO participants(telegram_user_id,full_name,phone,instagram)
       VALUES(?,?,?,?)
       ON DUPLICATE KEY UPDATE full_name=VALUES(full_name),phone=VALUES(phone),instagram=VALUES(instagram)`,
      [String(telegramUserId), fullName, phone, instagram]
    );
    const [[participant]] = await conn.execute(
      'SELECT id FROM participants WHERE telegram_user_id=? FOR UPDATE', [String(telegramUserId)]
    );
    const [[existing]] = await conn.execute(
      'SELECT id,status,payment_status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE',
      [campaign.id, participant.id]
    );
    if (existing) {
      const [[existingCode]] = await conn.execute(
        "SELECT code FROM issued_codes WHERE entry_id=? AND status='active' LIMIT 1", [existing.id]
      );
      await conn.commit();
      return { entryId: existing.id, existing: true, status: existing.status, paymentStatus: existing.payment_status, code: existingCode?.code || null };
    }

    if (campaign.capacity !== null) {
      const [[count]] = await conn.execute(
        "SELECT COUNT(*) AS total FROM campaign_entries WHERE campaign_id=? AND status IN ('active','pending_payment')",
        [campaign.id]
      );
      if (Number(count.total) >= Number(campaign.capacity)) throw Object.assign(new Error('CAMPAIGN_FULL'), { code: 'CAMPAIGN_FULL' });
    }

    if (!['free', 'manual_transfer'].includes(campaign.payment_mode)) {
      throw Object.assign(new Error('PAYMENT_MODE_UNAVAILABLE'), { code: 'PAYMENT_MODE_UNAVAILABLE' });
    }
    const requiresApproval = campaign.payment_mode === 'manual_transfer';
    const [entryResult] = await conn.execute(
      `INSERT INTO campaign_entries(campaign_id,participant_id,status,payment_status)
       VALUES(?,?,?,?)`,
      [campaign.id, participant.id, requiresApproval ? 'pending_payment' : 'active', requiresApproval ? 'pending' : 'not_required']
    );
    const entryId = entryResult.insertId;
    if (requiresApproval) {
      await conn.execute(
        'INSERT INTO campaign_payments(entry_id,mode,status,amount_minor,currency) VALUES(?,?,?,?,?)',
        [entryId, campaign.payment_mode, 'pending', campaign.amount_minor, campaign.currency]
      );
      await conn.commit();
      return { entryId, existing: false, status: 'pending_payment', paymentStatus: 'pending', code: null };
    }

    const code = await issueCodeInTransaction(conn, campaign.id, entryId, codeSecret);
    await conn.commit();
    return { entryId, existing: false, status: 'active', paymentStatus: 'not_required', code };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function approveManualPayment({ db, paymentId, reviewer, codeSecret }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[payment]] = await conn.execute(
      `SELECT p.id,p.entry_id,p.mode,p.status,e.campaign_id,e.status AS entry_status,
              c.status AS campaign_status,c.capacity
       FROM campaign_payments p
       JOIN campaign_entries e ON e.id=p.entry_id
       JOIN campaigns c ON c.id=e.campaign_id
       WHERE p.id=? FOR UPDATE`, [paymentId]
    );
    if (!payment || payment.mode !== 'manual_transfer' || payment.status !== 'pending') {
      throw Object.assign(new Error('PAYMENT_NOT_REVIEWABLE'), { code: 'PAYMENT_NOT_REVIEWABLE' });
    }
    if (payment.campaign_status !== 'active') throw Object.assign(new Error('CAMPAIGN_NOT_OPEN'), { code: 'CAMPAIGN_NOT_OPEN' });
    const [[count]] = await conn.execute(
      "SELECT COUNT(*) AS total FROM campaign_entries WHERE campaign_id=? AND status='active'",
      [payment.campaign_id]
    );
    if (payment.capacity !== null && Number(count.total) >= Number(payment.capacity)) {
      throw Object.assign(new Error('CAMPAIGN_FULL'), { code: 'CAMPAIGN_FULL' });
    }
    const [[existingCode]] = await conn.execute(
      "SELECT code FROM issued_codes WHERE entry_id=? AND status='active' LIMIT 1", [payment.entry_id]
    );
    let code = existingCode?.code || null;
    if (!code) code = await issueCodeInTransaction(conn, payment.campaign_id, payment.entry_id, codeSecret);
    await conn.execute(
      "UPDATE campaign_payments SET status='approved',reviewed_by=?,reviewed_at=NOW() WHERE id=?",
      [String(reviewer), paymentId]
    );
    await conn.execute(
      "UPDATE campaign_entries SET status='active',payment_status='approved' WHERE id=?",
      [payment.entry_id]
    );
    await conn.commit();
    return { entryId: payment.entry_id, approved: true, code };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function rejectManualPayment({ db, paymentId, reviewer, reason = 'رسید تأیید نشد' }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[payment]] = await conn.execute(
      `SELECT p.id,p.entry_id,p.mode,p.status FROM campaign_payments p WHERE p.id=? FOR UPDATE`, [paymentId]
    );
    if (!payment || payment.mode !== 'manual_transfer' || payment.status !== 'pending') {
      throw Object.assign(new Error('PAYMENT_NOT_REVIEWABLE'), { code: 'PAYMENT_NOT_REVIEWABLE' });
    }
    await conn.execute(
      "UPDATE campaign_payments SET status='rejected',reviewed_by=?,reviewed_at=NOW() WHERE id=?",
      [String(reviewer), paymentId]
    );
    await conn.execute(
      "UPDATE campaign_entries SET status='inactive',payment_status='rejected' WHERE id=? AND status='pending_payment'",
      [payment.entry_id]
    );
    await conn.commit();
    return { entryId: payment.entry_id, rejected: true, reason };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { makeCampaignCode, joinCampaign, approveManualPayment, rejectManualPayment };
