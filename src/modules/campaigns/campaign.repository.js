import {pool} from '../../database/pool.js';

export async function listOpenCampaigns({limit=8,offset=0}={}){
  const [rows]=await pool.execute(
    "SELECT id,slug,title,description,poster_file_id,prize_title,prize_description,prize_value,terms,status,participation_type,entry_price,payment_methods,starts_at,ends_at,draw_at,capacity,codes_per_entry,(SELECT COUNT(*) FROM campaign_entries e WHERE e.campaign_id=campaigns.id AND e.status IN ('eligible','pending_payment')) AS participant_count FROM campaigns WHERE status='open' AND (starts_at IS NULL OR starts_at<=UTC_TIMESTAMP()) AND (ends_at IS NULL OR ends_at>=UTC_TIMESTAMP()) ORDER BY starts_at IS NULL DESC,starts_at ASC,id DESC LIMIT ? OFFSET ?",
    [Math.max(1,Math.min(20,Number(limit)||8)),Math.max(0,Number(offset)||0)]
  );
  return rows;
}
export async function getCampaignById(id){
  const [rows]=await pool.execute(
    "SELECT c.id,c.slug,c.title,c.description,c.poster_file_id,c.prize_title,c.prize_description,c.prize_value,c.terms,c.status,c.participation_type,c.entry_price,c.payment_methods,c.starts_at,c.ends_at,c.draw_at,c.capacity,c.codes_per_entry,(SELECT COUNT(*) FROM campaign_entries e WHERE e.campaign_id=c.id AND e.status IN ('eligible','pending_payment')) AS participant_count FROM campaigns c WHERE c.id=? LIMIT 1",
    [id]
  );
  return rows[0]??null;
}
export async function listParticipantCodes(telegramUserId){
  const [rows]=await pool.execute(
    "SELECT c.id AS campaign_id,c.title AS campaign_title,cc.code,cc.created_at FROM participants p JOIN campaign_entries e ON e.participant_id=p.id JOIN campaigns c ON c.id=e.campaign_id JOIN campaign_codes cc ON cc.campaign_entry_id=e.id WHERE p.telegram_user_id=? ORDER BY cc.created_at DESC",
    [String(telegramUserId)]
  );
  return rows;
}
