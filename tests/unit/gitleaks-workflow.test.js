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


test('Gitleaks ignores only four exact historical CI fixture fingerprints',()=>{
  const ignore=readFileSync(new URL('../../.gitleaksignore',import.meta.url),'utf8').trim().split(/\\r?\\n/);
  assert.deepEqual(ignore,[
    '0c162dea1b54c90f0a23655f63bdfbeef076eb51:.github/workflows/ci.yml:generic-api-key:55',
    '0c162dea1b54c90f0a23655f63bdfbeef076eb51:.github/workflows/ci.yml:generic-api-key:59',
    'ad0581f278a5be35f73b29953a6fa74228881f29:.github/workflows/ci.yml:generic-api-key:42',
    'eae83785799f6d77a2f03c1ffdb177ac4f2bd25b:tests/mysql-migration.integration.test.js:generic-api-key:134'
  ]);
  assert.ok(ignore.every(line=>line.split(':').length===4),'allowlist entries must remain exact commit/path/rule/line fingerprints');
});
