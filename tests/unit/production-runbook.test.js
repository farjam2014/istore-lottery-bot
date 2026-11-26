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
  assert.match(hostAudit,/RUNNER_CONFIGS=.*find \/home \/opt \/root -maxdepth 5/);
  assert.match(hostAudit,/name \.runner/);
  assert.match(hostAudit,/name \.credentials/);
  assert.match(hostAudit,/name \.credentials_rsaparams/);
  assert.match(hostAudit,/runner_registration_metadata=none_detected/);
  assert.match(hostAudit,/Self-hosted GitHub Runner registration metadata remains/);
});

test('production runbook verifies exact append-only audit trigger definitions',()=>{
  const triggerLine=section.split('AUDIT_TRIGGER_COUNT=')[1]?.split(String.fromCharCode(10))[0]??'';
  assert.match(triggerLine,/EVENT_OBJECT_TABLE='admin_audit_log'/);
  assert.match(triggerLine,/ACTION_TIMING='BEFORE'/);
  assert.match(triggerLine,/trg_admin_audit_log_no_update' AND EVENT_MANIPULATION='UPDATE'/);
  assert.match(triggerLine,/trg_admin_audit_log_no_delete' AND EVENT_MANIPULATION='DELETE'/);
  assert.match(triggerLine,/REGEXP_REPLACE\(TRIM\(ACTION_STATEMENT\)/);
  assert.match(triggerLine,/ADMIN_AUDIT_LOG IS APPEND-ONLY/);
});

test('production host preflight requires a reachable versioned HTTPS privacy notice',()=>{
  const hostAudit=readFileSync(new URL('../../scripts/production-host-preflight.sh',import.meta.url),'utf8');
  assert.match(hostAudit,/PRIVACY_NOTICE_URL/);
  assert.match(hostAudit,/PRIVACY_NOTICE_VERSION/);
  assert.ok(hostAudit.includes('NOTICE_URL" =~ ^https://'));
  assert.match(hostAudit,/curl --fail --silent --show-error --location --max-time 10 --proto '=https' --proto-redir '=https'/);
  assert.match(hostAudit,/privacy_notice=reachable_https_with_version/);
  assert.ok(hostAudit.includes('NOTICE_HOST'));
  assert.ok(hostAudit.includes('www.example.com'));
  assert.ok(hostAudit.includes('*.invalid'));
});
