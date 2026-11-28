#!/usr/bin/env node
import {pool} from '../src/database/pool.js';
import {config} from '../src/config/env.js';
import {loadDrawKeyring,verifyPreparedDrawKeyRows} from '../src/modules/draw/draw-keyring.js';

try{
  const keyring=loadDrawKeyring(config);
  const [rows]=await pool.execute(
    "SELECT id,seed_key_id,seed_ciphertext,seed_nonce,seed_tag,seed_hash FROM campaign_draws WHERE status='prepared' ORDER BY id"
  );
  const result=verifyPreparedDrawKeyRows(rows,keyring);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.failed>0)process.exitCode=1;
}catch{
  process.stderr.write('PREPARED_DRAW_KEY_CHECK=FAILED (database, keyring configuration, or decryption verification error)\n');
  process.exitCode=1;
}finally{
  await pool.end().catch(()=>{});
}
