import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDrawKeyring,encryptDrawSeed,decryptDrawSeed} from '../../src/modules/draw/draw-keyring.js';

const oldKey='11'.repeat(32);
const newKey='22'.repeat(32);

test('legacy single-key environment remains compatible with legacy prepared draws',()=>{
  const keyring=loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEY:oldKey});
  const encrypted=encryptDrawSeed('a'.repeat(64),keyring);
  assert.equal(encrypted.keyId,'legacy-env');
  assert.equal(decryptDrawSeed({...encrypted,seed_key_id:'legacy-env'},keyring),'a'.repeat(64));
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
  assert.equal(decryptDrawSeed({...oldCiphertext,seed_key_id:'legacy-env'},rotated),'b'.repeat(64));
  assert.equal(decryptDrawSeed({...newCiphertext,seed_key_id:'2026-11'},rotated),'c'.repeat(64));
});

test('keyring rejects missing active keys, malformed key material and unknown historical key IDs',()=>{
  assert.throws(()=>loadDrawKeyring({DRAW_SEED_ACTIVE_KEY_ID:'missing',DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'key-a':oldKey})}),/must reference/);
  assert.throws(()=>loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEYS:'not-json'}),/valid JSON/);
  assert.throws(()=>loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEYS:JSON.stringify({'bad id':oldKey})}),/valid key ID/);
  const keyring=loadDrawKeyring({DRAW_SEED_ENCRYPTION_KEY:oldKey});
  assert.throws(()=>decryptDrawSeed({seed_key_id:'removed-key',seed_nonce:'00'.repeat(12),seed_tag:'00'.repeat(16),seed_ciphertext:''},keyring),/not available/);
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
  encrypted.seed_ciphertext=Buffer.from('tampered').toString('base64');
  assert.throws(()=>decryptDrawSeed({...encrypted,seed_key_id:encrypted.keyId},keyring),/decryption failed/);
});
