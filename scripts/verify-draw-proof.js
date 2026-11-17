#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {verifyDrawProof} from '../src/modules/draw/draw-verifier.js';

const file=process.argv[2];
if(!file||process.argv.length!==3){
  process.stderr.write('Usage: node scripts/verify-draw-proof.js <proof.json>\n');
  process.exitCode=2;
}else{
  try{
    const proof=JSON.parse(await readFile(file,'utf8'));
    const result=verifyDrawProof(proof);
    process.stdout.write(JSON.stringify({valid:result.valid,reason:result.reason||null,snapshotHash:result.snapshotHash||null},null,2)+'\n');
    if(!result.valid)process.exitCode=1;
  }catch(error){
    process.stderr.write('Invalid proof file: '+String(error.message||error)+'\n');
    process.exitCode=1;
  }
}
