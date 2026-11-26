import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const runbook=readFileSync(new URL('../../docs/PRODUCTION_STAGED_DEPLOYMENT.md',import.meta.url),'utf8');
const section=runbook.split('## 5. Approved maintenance window')[1]?.split('## 6. Point systemd')[0]??'';
const match=section.match(/Use this exact pattern:\n\n   \`\`\`bash\n([\s\S]*?)\n   \`\`\`/);

test('production migration runbook shell block is valid Bash',()=>{
  assert.ok(match,'The approved migration command block must exist in the runbook.');
  const result=spawnSync('bash',['-n'],{input:match[1],encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||'Bash syntax check failed.');
});

test('production migration runbook enforces root-only credentials and least privilege',()=>{
  assert.match(section,/test -d "\$MIGRATION_ENV_DIR" && test ! -L "\$MIGRATION_ENV_DIR"/);
  assert.match(section,/test "\$\(stat -c '%U' "\$MIGRATION_ENV"\)" = root/);
  assert.match(section,/test "\$\(stat -c '%a' "\$MIGRATION_ENV"\)" = 600/);
  assert.match(section,/MIGRATION_SCHEMA_PRIVILEGES/);
  assert.match(section,/MIGRATION_GLOBAL_PRIVILEGES/);
  assert.match(section,/MIGRATION_OTHER_SCHEMA_PRIVILEGES/);
  assert.match(section,/MIGRATION_TABLE_PRIVILEGES/);
  assert.doesNotMatch(section,/ALL PRIVILEGES ON/);
});

test('production host preflight detects residual self-hosted runner services and registrations',()=>{
  const hostAudit=readFileSync(new URL('../../scripts/production-host-preflight.sh',import.meta.url),'utf8');
  assert.match(hostAudit,/systemctl list-unit-files --type=service/);
  assert.match(hostAudit,/runner_unit_files=none_detected/);
  assert.match(hostAudit,/find \/home \/opt \/root -maxdepth 5 -type f -name \.runner/);
  assert.match(hostAudit,/runner_registration_metadata=none_detected/);
  assert.match(hostAudit,/Self-hosted GitHub Runner registration metadata remains/);
});
