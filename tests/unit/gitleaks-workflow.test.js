import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');

test('CI runs an explicit all-refs full-history Gitleaks scan in addition to the incremental PR scan',()=>{
  assert.match(workflow,/fetch-depth:\s*0/);
  assert.match(workflow,/gitleaks\/gitleaks-action@[0-9a-f]{40}/);
  assert.match(workflow,/name: Scan all Git refs and full history for secrets/);
  assert.match(workflow,/run: gitleaks git --redact --verbose --exit-code 2 \\./);
  assert.match(workflow,/GITLEAKS_ENABLE_COMMENTS: 'false'/);
  assert.match(workflow,/GITLEAKS_ENABLE_UPLOAD_ARTIFACT: 'false'/);
});
