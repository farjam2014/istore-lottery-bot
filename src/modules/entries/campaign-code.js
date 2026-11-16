import {randomInt} from 'node:crypto';
const RANDOM_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const RANDOM_LAST_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ0';
const MAX_SEQUENCE=999999;
function pick(alphabet,randomIntImpl){return alphabet[randomIntImpl(alphabet.length)];}
function randomSegment(length,randomIntImpl){
  if(length===0)return '';
  let value='';
  for(let i=0;i<length-1;i++)value+=pick(RANDOM_ALPHABET,randomIntImpl);
  value+=pick(RANDOM_LAST_ALPHABET,randomIntImpl);
  return value;
}
export function buildCampaignCode({campaignId,sequenceNumber,randomIntImpl=randomInt}){
  const campaign=String(campaignId);
  if(!/^\d+$/.test(campaign)||BigInt(campaign)<=0n)throw new Error('Invalid campaign ID');
  const sequence=Number(sequenceNumber);
  if(!Number.isSafeInteger(sequence)||sequence<1||sequence>MAX_SEQUENCE)throw new Error('Campaign code sequence is outside the supported range');
  const digits=String(sequence);
  const randomPrefix=randomSegment(6-digits.length,randomIntImpl);
  const suffix=randomSegment(2,randomIntImpl);
  return `P${campaign}-${randomPrefix}${digits}-${suffix}`;
}
export async function issueCampaignCodes(connection,{entryId,campaignId,requested}){
  const count=Math.max(1,Math.min(100,Number(requested)||1));
  const codes=[];
  for(let i=0;i<count;i++){
    await connection.execute('INSERT INTO campaign_code_counters(campaign_id,next_sequence_number) VALUES(?,10001) ON DUPLICATE KEY UPDATE campaign_id=VALUES(campaign_id)',[campaignId]);
    const [[counter]]=await connection.execute('SELECT next_sequence_number FROM campaign_code_counters WHERE campaign_id=? FOR UPDATE',[campaignId]);
    const sequence=Number(counter?.next_sequence_number);
    if(!Number.isSafeInteger(sequence)||sequence<1||sequence>MAX_SEQUENCE)throw new Error('ظرفیت شماره‌گذاری کدهای این کمپین به پایان رسیده است.');
    await connection.execute('UPDATE campaign_code_counters SET next_sequence_number=? WHERE campaign_id=?',[sequence+1,campaignId]);
    let inserted=false;
    for(let attempt=0;attempt<20&&!inserted;attempt++){
      const code=buildCampaignCode({campaignId,sequenceNumber:sequence});
      try{
        await connection.execute('INSERT INTO campaign_codes(campaign_entry_id,campaign_id,sequence_number,code) VALUES(?,?,?,?)',[entryId,campaignId,sequence,code]);
        codes.push(code);inserted=true;
      }catch(error){if(error.code!=='ER_DUP_ENTRY')throw error;}
    }
    if(!inserted)throw new Error('تولید کد یکتای کمپین ناموفق بود؛ عملیات لغو شد.');
  }
  return codes;
}
