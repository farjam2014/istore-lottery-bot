import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadDrawKeyring,encryptDrawSeed,decryptDrawSeed,verifyPreparedDrawKeyRows} from '../../src/modules/draw/draw-keyring.js';

const oldKey='11'.repeat(32);
const newKey='22'.repeat(32);
const row=encrypted=>({seed_ciphertext:encrypted.ciphertext,seed_nonce:encrypted.nonce,seed_tag:encrypted.tag,seed_key_id:encrypted.keyId});

test('legacy single-key environment remains compatible with legacy prepared draws',()=>{
  const keyring=loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEY:oldKey});
  const encrypted=encryptDrawSeed('a'.repeat(64),keyring);
  assert.equal(encrypted.keyId,'legacy-env');
  assert.equal(decryptDrawSeed(row(encrypted),keyring),'a'.repeat(64));
});

test('keyring rotation keeps old prepared draws decryptable while new draws use active key',()=>{
  const oldOnly=loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEY:oldKey});
  const oldCiphertext=encryptDrawSeed('b'.repeat(64),oldOnly);
  const rotated=loadDrawKeyring({
    DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'legacy-env':oldKey,'2026-11':newKey}),
    DRAW_SEED_ACTIVE_KEY_ID:'2026-11'
  });
  const newCiphertext=encryptDrawSeed('c'.repeat(64),rotated);
  assert.equal(newCiphertext.keyId,'2026-11');
  assert.equal(decryptDrawSeed(row(oldCiphertext),rotated),'b'.repeat(64));
  assert.equal(decryptDrawSeed(row(newCiphertext),rotated),'c'.repeat(64));
});

test('keyring rejects missing active keys, malformed key material and unknown historical key IDs',()=>{
  assert.throws(()=>loadDrawKeyring({DRAW_SEED_ACTIVE_KEY_ID:'missing',DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'key-a':oldKey})}),/must reference/);
  assert.throws(()=>loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEYS:'not-json'}),/valid JSON/);
  assert.throws(()=>loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'bad id':oldKey})}),/valid key ID/);
  const keyring=loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEY:oldKey});
  assert.throws(()=>decryptDrawSeed({seed_key_id:'removed-key',seed_nonce:'00'.repeat(12),seed_tag:'00'.repeat(16),seed_ciphertext:''},keyring),/not available/);
});

test('keyring safely supports reserved JavaScript property names as key IDs',()=>{
  const keyring=loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEYS:'{\"__proto__\":\"'+oldKey+'\"}',DRAW_SEED_ACTIVE_KEY_ID:'__proto__'});
  const encrypted=encryptDrawSeed('e'.repeat(64),keyring);
  assert.equal(encrypted.keyId,'__proto__');
  assert.equal(decryptDrawSeed(row(encrypted),keyring),'e'.repeat(64));
});

test('keyring rejects conflicting legacy and keyring definitions',()=>{
  assert.throws(()=>loadDrawKeyring({
    DRAW_SEED_ENCRYPTION_KEY:oldKey,
    DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'legacy-env':newKey})
  }),/Conflicting/);
});

test('authenticated encryption rejects tampered ciphertext',()=>{
  const keyring=loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEY:oldKey});
  const encrypted=encryptDrawSeed('d'.repeat(64),keyring);
  const tampered={...row(encrypted),seed_ciphertext:Buffer.from('tampered').toString('base64')};
  assert.throws(()=>decryptDrawSeed(tampered,keyring),/decryption failed/);
});


test('prepared draw restore verifier checks decryption and commitment without returning seed material',()=>{
  const keyring=loadDrawKeyring({
    DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'legacy-env':oldKey,'2026-11':newKey}),
    DRAW_SEED_ACTIVE_KEY_ID:'2026-11'
  });
  const seed='f'.repeat(64);
  const encrypted=encryptDrawSeed(seed,keyring);
  const result=verifyPreparedDrawKeyRows([{
    id:71,seed_key_id:encrypted.keyId,seed_ciphertext:encrypted.ciphertext,
    seed_nonce:encrypted.nonce,seed_tag:encrypted.tag,
    seed_hash:createHash('sha256').update(seed).digest('hex')
  }],keyring);
  assert.deepEqual(result,{status:'verified',checked:1,verified:1,failed:0,items:[{drawId:71,keyId:'2026-11',status:'verified',reason:null}]});
  assert.equal(JSON.stringify(result).includes(seed),false,'verification output must never contain the decrypted seed');
});

test('prepared draw restore verifier fails closed for missing historical keys, tampered ciphertext and commitment mismatch',()=>{
  const keyring=loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEY:oldKey});
  const seed='a'.repeat(64);
  const encrypted=encryptDrawSeed(seed,keyring);
  const base={
    id:72,seed_key_id:encrypted.keyId,seed_ciphertext:encrypted.ciphertext,
    seed_nonce:encrypted.nonce,seed_tag:encrypted.tag,
    seed_hash:createHash('sha256').update(seed).digest('hex')
  };
  const missing=verifyPreparedDrawKeyRows([{...base,seed_key_id:'removed-key'}],keyring);
  assert.equal(missing.items[0].reason,'key_unavailable');
  const tampered=verifyPreparedDrawKeyRows([{...base,seed_ciphertext:Buffer.from('tampered').toString('base64')}],keyring);
  assert.equal(tampered.items[0].reason,'decryption_failed');
  const mismatch=verifyPreparedDrawKeyRows([{...base,seed_hash:'0'.repeat(64)}],keyring);
  assert.equal(mismatch.items[0].reason,'commitment_mismatch');
  const malformedSeed=encryptDrawSeed('not-a-seed',keyring);
  const malformed=verifyPreparedDrawKeyRows([{...base,seed_ciphertext:malformedSeed.ciphertext,seed_nonce:malformedSeed.nonce,seed_tag:malformedSeed.tag}],keyring);
  assert.equal(malformed.items[0].reason,'seed_format_invalid');
  assert.equal(verifyPreparedDrawKeyRows([],keyring).status,'no_prepared_draws');
});
