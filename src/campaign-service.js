'use strict';
const crypto = require('node:crypto');
const { validFullName, validPhone, normalizeInstagram, validInstagram } = require('./domain');

function makeCampaignCode(campaignId, sequence, secret) {
  if (!secret || String(secret).length < 32) throw new Error('CAMPAIGN_CODE_SECRET must contain at least 32 characters');
  const digest = crypto.createHmac('sha256', secret)
    .update(String(campaignId) + ':' + String(sequence))
    .digest('hex').toUpperCase();
  return 'IS-' + digest.slice(0, 24);
}

/**
 * Keeps one profile/entry per Telegram identity and campaign. Free campaigns
 * issue one ticket; paid campaigns can issue multiple tickets against approved payments.
 * Provider payment confirmation still requires a separately authenticated webhook.
 */
async function issueCodeInTransaction(conn, campaignId, entryId, codeSecret, quantity = 1) {
  await conn.execute('INSERT IGNORE INTO campaign_sequences(campaign_id,last_sequence) VALUES(?,0)', [campaignId]);
  const [[sequenceRow]] = await conn.execute(
    'SELECT last_sequence FROM campaign_sequences WHERE campaign_id=? FOR UPDATE', [campaignId]
  );
  const sequence = Number(sequenceRow.last_sequence) + 1;
  const codes = [];
  for (let i = 0; i < quantity; i++) {
    const nextSequence = sequence + i;
    const code = makeCampaignCode(campaignId, nextSequence, codeSecret);
    await conn.execute(
      "INSERT INTO issued_codes(campaign_id,entry_id,sequence_no,code,status) VALUES(?,?,?,?, 'active')",
      [campaignId, entryId, nextSequence, code]
    );
    codes.push(code);
  }
  await conn.execute('UPDATE campaign_sequences SET last_sequence=? WHERE campaign_id=?', [sequence + quantity - 1, campaignId]);
  return codes;
}

async function joinCampaign({ db, telegramUserId, fullName, phone, instagram, chatId, businessConnectionId, campaignSlug, codeSecret, quantity = 1 }) {
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
    const requestedQuantity = Number(quantity);
    if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 10000) throw Object.assign(new Error('INVALID_CODE_QUANTITY'), { code: 'INVALID_CODE_QUANTITY' });
    if (campaign.payment_mode === 'free' && requestedQuantity !== 1) throw Object.assign(new Error('FREE_CAMPAIGN_SINGLE_CODE'), { code: 'FREE_CAMPAIGN_SINGLE_CODE' });
    const normalizedInstagram = normalizeInstagram(instagram);
    if (!validFullName(fullName) || !validPhone(phone) || !validInstagram(normalizedInstagram)) {
      throw Object.assign(new Error('INVALID_PARTICIPANT_PROFILE'), { code: 'INVALID_PARTICIPANT_PROFILE' });
    }

    // One real person must not enter an active campaign through multiple Telegram accounts.
    // Check before the profile upsert so a rejected update cannot overwrite an existing profile.
    const [[duplicatePhone]] = await conn.execute(
      `SELECT p.id FROM participants p
       JOIN campaign_entries e ON e.participant_id=p.id
       JOIN campaigns c ON c.id=e.campaign_id
       WHERE p.telegram_user_id<>?
         AND e.status IN ('active','pending_payment')
         AND c.status='active' AND p.phone=?
       LIMIT 1 FOR UPDATE`,
      [String(telegramUserId), phone]
    );
    const [[duplicateInstagram]] = await conn.execute(
      'SELECT id FROM participants WHERE telegram_user_id<>? AND instagram=? LIMIT 1 FOR UPDATE',
      [String(telegramUserId), normalizedInstagram]
    );
    const duplicate = duplicatePhone || duplicateInstagram;
    if (duplicate) throw Object.assign(new Error('DUPLICATE_CONTACT'), { code: 'DUPLICATE_CONTACT' });

    await conn.execute(
      `INSERT INTO participants(telegram_user_id,full_name,phone,instagram)
       VALUES(?,?,?,?)
       ON DUPLICATE KEY UPDATE full_name=VALUES(full_name),phone=VALUES(phone),instagram=VALUES(instagram)`,
      [String(telegramUserId), fullName, phone, normalizedInstagram]
    );
    const [[participant]] = await conn.execute(
      'SELECT id FROM participants WHERE telegram_user_id=? FOR UPDATE', [String(telegramUserId)]
    );
    const [[existing]] = await conn.execute(
      'SELECT id,status,payment_status FROM campaign_entries WHERE campaign_id=? AND participant_id=? FOR UPDATE',
      [campaign.id, participant.id]
    );
    const [[pendingAcrossCampaigns]] = await conn.execute(
      `SELECT cp.id,e.campaign_id FROM campaign_payments cp
       JOIN campaign_entries e ON e.id=cp.entry_id
       WHERE e.participant_id=? AND cp.status='pending' ORDER BY cp.id DESC LIMIT 1 FOR UPDATE`,
      [participant.id]
    );
    if (pendingAcrossCampaigns) {
      if (existing && existing.status === 'pending_payment' && Number(pendingAcrossCampaigns.campaign_id) === Number(campaign.id)) {
        const [[pendingPayment]] = await conn.execute("SELECT id FROM campaign_payments WHERE entry_id=? AND status='pending' ORDER BY id DESC LIMIT 1",[existing.id]);
        await conn.commit();
        return { entryId: existing.id, existing: true, status: 'pending_payment', paymentStatus: 'pending', paymentId: pendingPayment?.id || pendingAcrossCampaigns.id, code: null, codes: [] };
      }
      throw Object.assign(new Error('PAYMENT_ALREADY_PENDING'), { code: 'PAYMENT_ALREADY_PENDING' });
    }
    if (existing && existing.status === 'inactive' && existing.payment_status === 'rejected' && campaign.payment_mode === 'manual_transfer') {
      const [[priorCodes]] = await conn.execute("SELECT COUNT(*) AS total FROM issued_codes WHERE entry_id=? AND status='active'",[existing.id]);
      const [[priorPending]] = await conn.execute("SELECT COALESCE(SUM(quantity),0) AS total FROM campaign_payments WHERE entry_id=? AND status='pending'",[existing.id]);
      const maxCodes = campaign.max_codes_per_participant == null ? null : Number(campaign.max_codes_per_participant);
      if (maxCodes !== null && Number(priorCodes.total)+Number(priorPending.total)+requestedQuantity>maxCodes) throw Object.assign(new Error('CODE_LIMIT_EXCEEDED'), { code: 'CODE_LIMIT_EXCEEDED' });
      const totalAmount = Number(campaign.amount_minor) * requestedQuantity;
      if (!Number.isSafeInteger(totalAmount)) throw Object.assign(new Error('PAYMENT_AMOUNT_TOO_LARGE'), { code: 'PAYMENT_AMOUNT_TOO_LARGE' });
      const [retryPayment] = await conn.execute(
        "INSERT INTO campaign_payments(entry_id,mode,status,amount_minor,currency,quantity,telegram_chat_id,business_connection_id) VALUES(?,?,?,?,?,?,?,?)",
        [existing.id, 'manual_transfer', 'pending', totalAmount, campaign.currency, requestedQuantity, String(chatId), businessConnectionId ? String(businessConnectionId) : null]
      );
      await conn.execute("UPDATE campaign_entries SET status='pending_payment',payment_status='pending' WHERE id=?", [existing.id]);
      await conn.commit();
      return { entryId: existing.id, existing: true, status: 'pending_payment', paymentStatus: 'pending', paymentId: retryPayment.insertId, quantity: requestedQuantity, code: null, codes: [] };
    }
    if (existing) {
      const [existingCodes] = await conn.execute(
        "SELECT code FROM issued_codes WHERE entry_id=? AND status='active' ORDER BY sequence_no,id", [existing.id]
      );
      if (campaign.payment_mode === 'free' || existing.status === 'pending_payment') {
        let pendingPayment = null;
        if (existing.status === 'pending_payment') {
          const [[row]] = await conn.execute("SELECT id FROM campaign_payments WHERE entry_id=? AND status='pending' ORDER BY id DESC LIMIT 1", [existing.id]);
          pendingPayment = row || null;
        }
        await conn.commit();
        return { entryId: existing.id, existing: true, status: existing.status, paymentStatus: existing.payment_status, paymentId: pendingPayment?.id || null, code: existingCodes?.[0]?.code || null, codes: existingCodes.map(x => x.code) };
      }
      if (campaign.payment_mode !== 'manual_transfer') throw Object.assign(new Error('PAYMENT_MODE_UNAVAILABLE'), { code: 'PAYMENT_MODE_UNAVAILABLE' });
      const [[pendingTotals]] = await conn.execute(
        "SELECT COALESCE(SUM(quantity),0) AS total FROM campaign_payments WHERE entry_id=? AND status='pending'", [existing.id]
      );
      const currentCount = existingCodes.length + Number(pendingTotals.total);
      const maxCodes = campaign.max_codes_per_participant == null ? null : Number(campaign.max_codes_per_participant);
      if (maxCodes !== null && currentCount + requestedQuantity > maxCodes) throw Object.assign(new Error('CODE_LIMIT_EXCEEDED'), { code: 'CODE_LIMIT_EXCEEDED' });
      const [[alreadyPending]] = await conn.execute("SELECT id FROM campaign_payments WHERE entry_id=? AND status='pending' LIMIT 1 FOR UPDATE",[existing.id]);
      if (alreadyPending) throw Object.assign(new Error('PAYMENT_ALREADY_PENDING'), { code: 'PAYMENT_ALREADY_PENDING' });
      const totalAmount = Number(campaign.amount_minor) * requestedQuantity;
      if (!Number.isSafeInteger(totalAmount)) throw Object.assign(new Error('PAYMENT_AMOUNT_TOO_LARGE'), { code: 'PAYMENT_AMOUNT_TOO_LARGE' });
      const [paymentResult] = await conn.execute(
        "INSERT INTO campaign_payments(entry_id,mode,status,amount_minor,currency,quantity,telegram_chat_id,business_connection_id) VALUES(?,?,?,?,?,?,?,?)",
        [existing.id, 'manual_transfer', 'pending', totalAmount, campaign.currency, requestedQuantity, String(chatId), businessConnectionId ? String(businessConnectionId) : null]
      );
      await conn.commit();
      return { entryId: existing.id, existing: true, status: 'pending_payment', paymentStatus: 'pending', paymentId: paymentResult.insertId, quantity: requestedQuantity, code: null, codes: [] };
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
    if (campaign.payment_mode === 'free' && requestedQuantity !== 1) throw Object.assign(new Error('FREE_CAMPAIGN_SINGLE_CODE'), { code: 'FREE_CAMPAIGN_SINGLE_CODE' });
    const maxCodes = campaign.payment_mode === 'free' ? 1 : (campaign.max_codes_per_participant == null ? null : Number(campaign.max_codes_per_participant));
    if (maxCodes !== null && requestedQuantity > maxCodes) throw Object.assign(new Error('CODE_LIMIT_EXCEEDED'), { code: 'CODE_LIMIT_EXCEEDED' });
    const totalAmount = Number(campaign.amount_minor) * requestedQuantity;
    if (requiresApproval && !Number.isSafeInteger(totalAmount)) throw Object.assign(new Error('PAYMENT_AMOUNT_TOO_LARGE'), { code: 'PAYMENT_AMOUNT_TOO_LARGE' });
    const [entryResult] = await conn.execute(
      `INSERT INTO campaign_entries(campaign_id,participant_id,status,payment_status)
       VALUES(?,?,?,?)`,
      [campaign.id, participant.id, requiresApproval ? 'pending_payment' : 'active', requiresApproval ? 'pending' : 'not_required']
    );
    const entryId = entryResult.insertId;
    if (requiresApproval) {
      await conn.execute(
        'INSERT INTO campaign_payments(entry_id,mode,status,amount_minor,currency,quantity,telegram_chat_id,business_connection_id) VALUES(?,?,?,?,?,?,?,?)',
        [entryId, campaign.payment_mode, 'pending', totalAmount, campaign.currency, requestedQuantity, String(chatId), businessConnectionId ? String(businessConnectionId) : null]
      );
      const paymentId = (await conn.execute("SELECT LAST_INSERT_ID() AS id"))[0][0].id;
      await conn.commit();
      return { entryId, existing: false, status: 'pending_payment', paymentStatus: 'pending', paymentId, quantity: requestedQuantity, code: null, codes: [] };
    }

    const codes = await issueCodeInTransaction(conn, campaign.id, entryId, codeSecret, 1);
    await conn.commit();
    return { entryId, existing: false, status: 'active', paymentStatus: 'not_required', code: codes[0], codes };
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
    const [[proof]] = await conn.execute('SELECT id FROM campaign_payment_proofs WHERE payment_id=? LIMIT 1 FOR UPDATE', [paymentId]);
    if (!proof) throw Object.assign(new Error('PAYMENT_PROOF_REQUIRED'), { code: 'PAYMENT_PROOF_REQUIRED' });
    if (payment.campaign_status === 'archived') throw Object.assign(new Error('CAMPAIGN_NOT_OPEN'), { code: 'CAMPAIGN_NOT_OPEN' });
    const [[count]] = await conn.execute(
      "SELECT COUNT(*) AS total FROM campaign_entries WHERE campaign_id=? AND status='active'",
      [payment.campaign_id]
    );
    if (payment.entry_status === 'pending_payment' && payment.capacity !== null && Number(count.total) >= Number(payment.capacity)) {
      throw Object.assign(new Error('CAMPAIGN_FULL'), { code: 'CAMPAIGN_FULL' });
    }
    const [[thisPayment]] = await conn.execute("SELECT quantity FROM campaign_payments WHERE id=?",[paymentId]);
    const quantity = Number(thisPayment.quantity || 1);
    const codes = await issueCodeInTransaction(conn, payment.campaign_id, payment.entry_id, codeSecret, quantity);
    await conn.execute(
      "UPDATE campaign_payments SET status='approved',reviewed_by=?,reviewed_at=NOW() WHERE id=?",
      [String(reviewer), paymentId]
    );
    await conn.execute(
      "UPDATE campaign_entries SET status='active',payment_status='approved' WHERE id=?",
      [payment.entry_id]
    );
    await conn.commit();
    return { entryId: payment.entry_id, approved: true, quantity, codes, code: codes[0] };
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
    const [[activeCodes]] = await conn.execute("SELECT COUNT(*) AS total FROM issued_codes WHERE entry_id=? AND status='active'",[payment.entry_id]);
    await conn.execute(
      "UPDATE campaign_entries SET status=?,payment_status=? WHERE id=?",
      [Number(activeCodes.total)>0?'active':'inactive', Number(activeCodes.total)>0?'approved':'rejected', payment.entry_id]
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
