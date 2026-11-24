import {pool} from '../../database/pool.js';

const allowedStatuses=new Set(['all','awaiting_receipt','under_review','approved','rejected','cancelled','expired']);
function normalizeFilter(status='all'){return allowedStatuses.has(status)?status:'all';}
export async function listManagedOrders({status='all',page=0,limit=10}={}){
  const filter=normalizeFilter(status),size=Math.max(1,Math.min(50,Number(limit)||10)),offset=Math.max(0,Number(page)||0)*size;
  const where=filter==='all'?'':'WHERE o.status=?',params=filter==='all'?[size,offset]:[filter,size,offset];
  const [rows]=await pool.execute(
    "SELECT o.id,o.payment_reference,o.amount,o.requested_code_count,o.currency,o.status,o.expires_at,o.created_at,o.approved_at,c.id campaign_id,c.title campaign_title,p.id participant_id,p.telegram_user_id,p.full_name,p.phone,p.instagram_handle,(SELECT COUNT(*) FROM payment_receipts pr WHERE pr.order_id=o.id) receipt_count FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id JOIN participants p ON p.id=e.participant_id "+where+" ORDER BY o.id DESC LIMIT ? OFFSET ?",params);
  const [[count]]=await pool.execute("SELECT COUNT(*) total FROM payment_orders o "+where,filter==='all'?[]:[filter]);
  return {rows,total:Number(count.total),page:Math.max(0,Number(page)||0),limit:size,status:filter};
}
export async function searchManagedOrders(query,{limit=20}={}){
  const q=String(query||'').trim().slice(0,100);if(!q)throw Error('عبارت جست‌وجو خالی است.');
  const like='%'+q.replace(/[!%_]/g,'!$&')+'%';
  const [rows]=await pool.execute(
    "SELECT o.id,o.payment_reference,o.amount,o.requested_code_count,o.currency,o.status,o.expires_at,o.created_at,c.title campaign_title,p.telegram_user_id,p.full_name,p.phone FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id JOIN participants p ON p.id=e.participant_id WHERE o.payment_reference=? OR CAST(o.id AS CHAR)=? OR CAST(p.telegram_user_id AS CHAR)=? OR p.phone LIKE ? ESCAPE '!' ORDER BY o.id DESC LIMIT ?",
    [q,q,q,like,Math.max(1,Math.min(50,Number(limit)||20))]);
  return rows;
}
export async function getManagedOrderDetail(orderId){
  const [[order]]=await pool.execute(
    "SELECT o.id,o.payment_reference,o.amount,o.requested_code_count,o.currency,o.status,o.expires_at,o.bank_name,o.card_number,o.card_holder,o.payment_instructions,o.rejection_reason,o.approved_by,o.approved_at,o.created_at,o.updated_at,c.id campaign_id,c.title campaign_title,c.participation_type,e.status entry_status,e.id entry_id,p.id participant_id,p.telegram_user_id,p.full_name,p.phone,p.instagram_handle,p.telegram_username FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id JOIN participants p ON p.id=e.participant_id WHERE o.id=?",[orderId]);
  if(!order)return null;
  const [receipts]=await pool.execute("SELECT id,telegram_file_id,telegram_file_unique_id,note,review_note,status,reviewed_by,reviewed_at,created_at FROM payment_receipts WHERE order_id=? ORDER BY id DESC",[orderId]);
  const [events]=await pool.execute("SELECT id,actor_telegram_id,event_type,details,created_at FROM payment_events WHERE order_id=? ORDER BY id DESC LIMIT 50",[orderId]);
  return {order,receipts,events};
}
export async function exportManagedOrders({status='all',limit=10000}={}){
  const filter=normalizeFilter(status),where=filter==='all'?'':'WHERE o.status=?';
  const [rows]=await pool.execute(
    "SELECT o.id,o.payment_reference,o.amount,o.requested_code_count,o.currency,o.status,o.expires_at,o.created_at,o.approved_at,c.id campaign_id,c.title campaign_title FROM payment_orders o JOIN campaign_entries e ON e.id=o.campaign_entry_id JOIN campaigns c ON c.id=e.campaign_id "+where+" ORDER BY o.id DESC LIMIT ?",
    filter==='all'?[Math.max(1,Math.min(10000,Number(limit)||10000))]:[filter,Math.max(1,Math.min(10000,Number(limit)||10000))]);
  return rows;
}
