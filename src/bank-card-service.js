'use strict';

function normalizeCardNumber(value) {
  const fa='۰۱۲۳۴۵۶۷۸۹', ar='٠١٢٣٤٥٦٧٨٩';
  return String(value ?? '').replace(/[۰-۹٠-٩]/g,c=>String(fa.indexOf(c)>=0?fa.indexOf(c):ar.indexOf(c))).replace(/[\s-]/g,'');
}
function maskCard(value) { const n=normalizeCardNumber(value); return n.length===16 ? '•••• •••• •••• '+n.slice(-4) : 'نامعتبر'; }
function createBankCardService({db,adminId}) {
  async function addCard({label,bankName=null,cardNumber,cardholderName}) {
    const number=normalizeCardNumber(cardNumber), name=String(cardholderName||'').trim(), title=String(label||'').trim();
    if(!/^\d{16}$/.test(number)) throw new Error('شماره کارت باید دقیقاً ۱۶ رقم باشد.');
    if(!name||name.length>150) throw new Error('نام دارنده کارت نامعتبر است.');
    if(!title||title.length>100) throw new Error('عنوان کارت نامعتبر است.');
    const [r]=await db.execute("INSERT INTO bank_cards(label,bank_name,card_number,cardholder_name,created_by) VALUES(?,?,?,?,?)",[title,bankName?String(bankName).trim().slice(0,80):null,number,name,String(adminId)]);
    return {id:r.insertId};
  }
  async function listCards({includeInactive=true}={}) {
    const [rows]=await db.execute("SELECT id,label,bank_name,RIGHT(card_number,4) last4,cardholder_name,status,created_at,updated_at FROM bank_cards WHERE (?=1 OR status='active') ORDER BY status='active' DESC,id DESC",[includeInactive?1:0]);
    return rows;
  }
  async function getCard(id,{activeOnly=false}={}) {
    const [rows]=await db.execute("SELECT id,label,bank_name,card_number,cardholder_name,status FROM bank_cards WHERE id=? LIMIT 1",[id]);
    const card=rows[0];
    if(!card || (activeOnly&&card.status!=='active')) throw new Error('کارت پیدا نشد یا غیرفعال است.');
    return card;
  }
  async function updateCard({id,label,bankName=null,cardNumber,cardholderName}) {
    const number=normalizeCardNumber(cardNumber), name=String(cardholderName||'').trim(), title=String(label||'').trim();
    if(!/^\d{16}$/.test(number)||!name||name.length>150||!title||title.length>100) throw new Error('مشخصات کارت معتبر نیست.');
    const [r]=await db.execute("UPDATE bank_cards SET label=?,bank_name=?,card_number=?,cardholder_name=?,updated_by=? WHERE id=?",[title,bankName?String(bankName).trim().slice(0,80):null,number,name,String(adminId),id]);
    if(!r.affectedRows) throw new Error('کارت پیدا نشد.');
    return {id:Number(id)};
  }
  async function setCardStatus(id,status) {
    if(!['active','inactive'].includes(status)) throw new Error('وضعیت کارت نامعتبر است.');
    const [r]=await db.execute('UPDATE bank_cards SET status=?,updated_by=? WHERE id=?',[status,String(adminId),id]);
    if(!r.affectedRows) throw new Error('کارت پیدا نشد.');
    return {id:Number(id),status};
  }
  async function assignCampaignCard(campaignId,cardId,reason='') {
    const conn=await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[campaign]]=await conn.execute('SELECT id,payment_mode FROM campaigns WHERE id=? FOR UPDATE',[campaignId]);
      if(!campaign) throw new Error('کمپین پیدا نشد.');
      if(campaign.payment_mode!=='manual') throw new Error('فقط کمپین پرداخت دستی کارت مقصد دارد.');
      const [[card]]=await conn.execute("SELECT id,status FROM bank_cards WHERE id=? FOR UPDATE",[cardId]);
      if(!card||card.status!=='active') throw new Error('کارت انتخاب‌شده فعال نیست.');
      await conn.execute('UPDATE campaigns SET current_payment_card_id=? WHERE id=?',[cardId,campaignId]);
      await conn.execute('INSERT INTO campaign_payment_card_history(campaign_id,card_id,changed_by,change_reason) VALUES(?,?,?,?)',[campaignId,cardId,String(adminId),String(reason).slice(0,255)]);
      await conn.execute('INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',[String(adminId),'assign_campaign_card','campaign',String(campaignId),JSON.stringify({card_id:Number(cardId)})]);
      await conn.commit();
      return {campaignId:Number(campaignId),cardId:Number(cardId)};
    } catch(e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }
  async function currentCampaignCard(campaignId) {
    const [rows]=await db.execute("SELECT b.id,b.label,b.bank_name,b.card_number,b.cardholder_name,b.status FROM campaigns c JOIN bank_cards b ON b.id=c.current_payment_card_id WHERE c.id=? LIMIT 1",[campaignId]);
    if(!rows[0]||rows[0].status!=='active') throw new Error('مدیر هنوز کارت فعال برای این کمپین انتخاب نکرده است.');
    return rows[0];
  }
  async function recordDelivery({orderId,card}) {
    await db.execute('INSERT INTO payment_order_card_deliveries(order_id,card_id,card_label_snapshot,bank_name_snapshot,card_number_snapshot,cardholder_name_snapshot) VALUES(?,?,?,?,?,?)',[orderId,card.id,card.label,card.bank_name,card.card_number,card.cardholder_name]);
  }
  async function deliveries(orderId) {
    const [rows]=await db.execute('SELECT card_label_snapshot,bank_name_snapshot,RIGHT(card_number_snapshot,4) last4,cardholder_name_snapshot,sent_at FROM payment_order_card_deliveries WHERE order_id=? ORDER BY id DESC',[orderId]);
    return rows;
  }
  return {addCard,listCards,getCard,updateCard,setCardStatus,assignCampaignCard,currentCampaignCard,recordDelivery,deliveries};
}
module.exports={createBankCardService,normalizeCardNumber,maskCard};
