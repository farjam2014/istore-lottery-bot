import {pool} from '../../database/pool.js';

export async function getManagementReport(){
  const [[users]]=await pool.execute("SELECT COUNT(*) total, SUM(status='active') active, SUM(status='blocked') blocked FROM participants");
  const [[campaigns]]=await pool.execute("SELECT COUNT(*) total, SUM(status='open') open_count, SUM(status='draft') draft_count, SUM(status='closed') closed_count FROM campaigns");
  const [[entries]]=await pool.execute("SELECT COUNT(*) total, SUM(status='eligible') eligible, SUM(status='pending_payment') pending_payment, SUM(status='cancelled') cancelled FROM campaign_entries");
  const [[payments]]=await pool.execute("SELECT COUNT(*) total, SUM(status='approved') approved_count, SUM(status IN ('awaiting_receipt','under_review')) pending_count, SUM(status='rejected') rejected_count, COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) revenue, COALESCE(SUM(CASE WHEN status IN ('awaiting_receipt','under_review','rejected') THEN amount ELSE 0 END),0) pending_amount FROM payment_orders");
  const [[receipts]]=await pool.execute("SELECT COUNT(*) total, SUM(status='submitted') submitted, SUM(status='approved') approved, SUM(status='rejected') rejected FROM payment_receipts");
  const [topCampaigns]=await pool.execute("SELECT c.id,c.title,c.status,c.participation_type,c.entry_price,COALESCE(e.entries,0) entries,COALESCE(e.eligible,0) eligible,COALESCE(p.paid_orders,0) paid_orders,COALESCE(p.revenue,0) revenue FROM campaigns c LEFT JOIN (SELECT campaign_id,COUNT(*) entries,SUM(status='eligible') eligible FROM campaign_entries GROUP BY campaign_id) e ON e.campaign_id=c.id LEFT JOIN (SELECT ce.campaign_id,COUNT(*) paid_orders,SUM(po.amount) revenue FROM payment_orders po JOIN campaign_entries ce ON ce.id=po.campaign_entry_id WHERE po.status='approved' GROUP BY ce.campaign_id) p ON p.campaign_id=c.id ORDER BY revenue DESC,entries DESC,c.id DESC LIMIT 10");
  const [[recent]]=await pool.execute("SELECT SUM(created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY) orders_created_30d,SUM(status='approved' AND approved_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY) approved_orders_30d,COALESCE(SUM(CASE WHEN status='approved' AND approved_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY THEN amount ELSE 0 END),0) revenue_30d FROM payment_orders WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY OR approved_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY");
  const [[newUsers]]=await pool.execute("SELECT COUNT(*) new_users_30d FROM participants WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY");
  return {users,campaigns,entries,payments,receipts,topCampaigns,recent,newUsers};
}

export function reportRows(report){
  return report.topCampaigns.map(c=>({
    campaign_id:c.id,title:c.title,status:c.status,type:c.participation_type,
    entry_price:c.entry_price,entries:c.entries,eligible:c.eligible,
    approved_orders:c.paid_orders,revenue_irr:c.revenue
  }));
}
