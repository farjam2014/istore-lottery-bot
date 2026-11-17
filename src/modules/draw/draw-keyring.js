import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';

const KEY_ID_PATTERN=/^[A-Za-z0-9._-]{1,64}$/;
const KEY_PATTERN=/^[a-f0-9]{64}$/i;

export function loadDrawKeyring(env=process.env){
  const keys={};
  const raw=String(env.DRAW_SEED_ENCRYPTION_KEYS??'').trim();
  if(raw){
    let parsed;
    try{parsed=JSON.parse(raw);}catch{throw new Error('DRAW_SEED_ENCRYPTION_KEYS must be a valid JSON object mapping key IDs to 64-character hexadecimal keys.');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new Error('DRAW_SEED_ENCRYPTION_KEYS must be a JSON object.');
    for(const [id,value] of Object.entries(parsed)){
      if(!KEY_ID_PATTERN.test(id)||!KEY_PATTERN.test(String(value))) throw new Error('Every draw key must have a valid key ID and exactly 32 bytes of hexadecimal key material.');
      keys[id]=Buffer.from(String(value),'hex');
    }
  }
  const legacy=String(env.DRAW_SEED_ENCRYPTION_KEY??'').trim();
  if(legacy){
    if(!KEY_PATTERN.test(legacy)) throw new Error('DRAW_SEED_ENCRYPTION_KEY must contain exactly 32 bytes of hexadecimal key material.');
    if(keys['legacy-env']&&!keys['legacy-env'].equals(Buffer.from(legacy,'hex'))) throw new Error('Conflicting legacy-env key values were configured.');
    keys['legacy-env']=Buffer.from(legacy,'hex');
  }
  const activeKeyId=String(env.DRAW_SEED_ACTIVE_KEY_ID??'legacy-env').trim();
  if(!KEY_ID_PATTERN.test(activeKeyId)||!keys[activeKeyId]) throw new Error('DRAW_SEED_ACTIVE_KEY_ID must reference a configured draw encryption key.');
  return {keys,activeKeyId};
}

export function encryptDrawSeed(seed,keyring=loadDrawKeyring()){
  const key=keyring?.keys?.[keyring.activeKeyId];
  if(!key||!Buffer.isBuffer(key)||key.length!==32) throw new Error('Active draw encryption key is unavailable.');
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  const ciphertext=Buffer.concat([cipher.update(String(seed),'utf8'),cipher.final()]);
  return {ciphertext:ciphertext.toString('base64'),nonce:nonce.toString('hex'),tag:cipher.getAuthTag().toString('hex'),keyId:keyring.activeKeyId};
}

export function decryptDrawSeed(row,keyring=loadDrawKeyring()){
  const keyId=String(row?.seed_key_id??'legacy-env');
  const key=keyring?.keys?.[keyId];
  if(!key||!Buffer.isBuffer(key)||key.length!==32) throw new Error('Draw seed encryption key "'+keyId+'" is not available; retain the corresponding key to complete or recover this draw.');
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(row.seed_nonce,'hex'));
    decipher.setAuthTag(Buffer.from(row.seed_tag,'hex'));
    return Buffer.concat([decipher.update(Buffer.from(row.seed_ciphertext,'base64')),decipher.final()]).toString('utf8');
  }catch{
    throw new Error('Draw seed decryption failed. The configured key may be incorrect or the stored ciphertext may be corrupted.');
  }
}
