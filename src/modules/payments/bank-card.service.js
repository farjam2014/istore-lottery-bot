import {pool} from '../../database/pool.js';
import {getCorrelationId} from '../../shared/request-context.js';

async function writeCardAudit(connection,adminId,action,cardId,details={}){
  await connection.execute('INSERT INTO admin_audit_log(admin_telegram_id,correlation_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)',[String(adminId),getCorrelationId(),action,'payment_bank_card',cardId,JSON.stringify(details)]);
}

export function normalizeCardNumber(value){
  const number=String(value??'').replace(/[\s-]/g,'');
  if(!/^\d{16}$/.test(number))throw new Error('شماره کارت باید دقیقاً ۱۶ رقم باشد.');
  return number;
}
function normalizeInput({bankName,cardNumber,cardHolder,instructions=''}){
  const bank=String(bankName??'').trim();
  const holder=String(cardHolder??'').trim();
  const note=String(instructions??'').trim();
  if(bank.length<2||bank.length>80)throw new Error('نام بانک باید بین ۲ تا ۸۰ نویسه باشد.');
  if(holder.length<3||holder.length>120)throw new Error('نام صاحب کارت باید بین ۳ تا ۱۲۰ نویسه باشد.');
  if(note.length>500)throw new Error('توضیحات حداکثر ۵۰۰ نویسه باشد.');
  return {bankName:bank,cardNumber:normalizeCardNumber(cardNumber),cardHolder:holder,instructions:note||null};
}
export async function listPaymentCards({includeInactive=true}={}){
  const where=includeInactive?'':'WHERE is_active=1';
  const [rows]=await pool.execute('SELECT id,bank_name,card_number,card_holder,instructions,is_active,is_default,created_at,updated_at FROM payment_bank_cards '+where+' ORDER BY is_default DESC,is_active DESC,id DESC');
  return rows;
}
export async function getPaymentCard(id){
  const [[row]]=await pool.execute('SELECT id,bank_name,card_number,card_holder,instructions,is_active,is_default FROM payment_bank_cards WHERE id=?',[id]);
  return row??null;
}
export async function createPaymentCard(input,adminId){
  const v=normalizeInput(input),c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [existing]=await c.execute('SELECT id FROM payment_bank_cards ORDER BY id FOR UPDATE');
    const makeDefault=existing.length===0;
    const [r]=await c.execute('INSERT INTO payment_bank_cards(bank_name,card_number,card_holder,instructions,is_active,is_default,created_by,updated_by) VALUES(?,?,?,?,1,?,?,?)',[v.bankName,v.cardNumber,v.cardHolder,v.instructions,makeDefault?1:0,String(adminId),String(adminId)]);
    await writeCardAudit(c,adminId,'payment_card.created',r.insertId,{bankName:v.bankName,cardLast4:v.cardNumber.slice(-4),default:makeDefault});
    await c.commit();return {id:r.insertId,default:makeDefault};
  }catch(e){await c.rollback();if(e.code==='ER_DUP_ENTRY')throw new Error('این شماره کارت قبلاً ثبت شده است.');throw e;}finally{c.release();}
}
export async function updatePaymentCard(id,input,adminId){
  const v=normalizeInput(input),c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [[card]]=await c.execute('SELECT id FROM payment_bank_cards WHERE id=? FOR UPDATE',[id]);
    if(!card)throw new Error('کارت موردنظر پیدا نشد.');
    await c.execute('UPDATE payment_bank_cards SET bank_name=?,card_number=?,card_holder=?,instructions=?,updated_by=? WHERE id=?',[v.bankName,v.cardNumber,v.cardHolder,v.instructions,String(adminId),id]);
    await writeCardAudit(c,adminId,'payment_card.updated',id,{bankName:v.bankName,cardLast4:v.cardNumber.slice(-4)});
    await c.commit();
  }catch(e){await c.rollback();if(e.code==='ER_DUP_ENTRY')throw new Error('این شماره کارت برای کارت دیگری ثبت شده است.');throw e;}finally{c.release();}
  return getPaymentCard(id);
}
export async function setDefaultPaymentCard(id,adminId){
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    await c.execute('SELECT id FROM payment_bank_cards ORDER BY id FOR UPDATE');
    const [[card]]=await c.execute('SELECT id,is_active FROM payment_bank_cards WHERE id=? FOR UPDATE',[id]);
    if(!card)throw new Error('کارت موردنظر پیدا نشد.');
    if(Number(card.is_active)!==1)throw new Error('برای کارت غیرفعال نمی‌توان پیش‌فرض تعیین کرد.');
    if(Number(card.is_default)===1){await c.commit();return;}
    await c.execute('UPDATE payment_bank_cards SET is_default=0,updated_by=? WHERE is_default=1',[String(adminId)]);
    await c.execute('UPDATE payment_bank_cards SET is_default=1,updated_by=? WHERE id=?',[String(adminId),id]);
    await writeCardAudit(c,adminId,'payment_card.default_changed',id,{});
    await c.commit();
  }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export async function setPaymentCardActive(id,active,adminId){
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    await c.execute('SELECT id FROM payment_bank_cards ORDER BY id FOR UPDATE');
    const [[card]]=await c.execute('SELECT id,is_active,is_default FROM payment_bank_cards WHERE id=? FOR UPDATE',[id]);
    if(!card)throw new Error('کارت موردنظر پیدا نشد.');
    if(Number(card.is_active)===(active?1:0)){await c.commit();return;}
    if(!active&&Number(card.is_default)===1){
      const [[other]]=await c.execute('SELECT id FROM payment_bank_cards WHERE is_active=1 AND id<>? ORDER BY id LIMIT 1 FOR UPDATE',[id]);
      if(!other)throw new Error('این تنها کارت فعال و پیش‌فرض است. ابتدا کارت دیگری اضافه و پیش‌فرض کنید.');
      await c.execute('UPDATE payment_bank_cards SET is_default=0,updated_by=? WHERE id=?',[String(adminId),id]);
      await c.execute('UPDATE payment_bank_cards SET is_default=1,updated_by=? WHERE id=?',[String(adminId),other.id]);
    }
    if(!active){
      const [[remaining]]=await c.execute('SELECT COUNT(*) total FROM payment_bank_cards WHERE is_active=1 AND id<>?',[id]);
      if(Number(remaining.total)===0)throw new Error('حداقل یک کارت باید فعال بماند.');
    }
    await c.execute('UPDATE payment_bank_cards SET is_active=?,updated_by=? WHERE id=?',[active?1:0,String(adminId),id]);
    await writeCardAudit(c,adminId,active?'payment_card.activated':'payment_card.deactivated',id,{active:Boolean(active)});
    await c.commit();
  }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export async function getDefaultPaymentCard(executor=pool,{lock=false}={}){
  const suffix=lock?' FOR UPDATE':'';
  const [[row]]=await executor.execute('SELECT id,bank_name,card_number,card_holder,instructions FROM payment_bank_cards WHERE is_active=1 AND is_default=1 ORDER BY id LIMIT 1'+suffix);
  return row??null;
}
