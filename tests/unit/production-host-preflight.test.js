import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../scripts/production-host-preflight.sh',import.meta.url),'utf8');

test('production host preflight rejects role grants and alternate host identities for both DB accounts',()=>{
  assert.match(source,/mysql\.role_edges WHERE TO_USER='\$APP_USER' AND TO_HOST='127\.0\.0\.1'/);
  assert.match(source,/mysql\.role_edges WHERE TO_USER='\$MIG_USER' AND TO_HOST='127\.0\.0\.1'/);
  assert.match(source,/mysql\.user WHERE User='\$APP_USER' AND Host<>'127\.0\.0\.1'/);
  assert.match(source,/mysql\.user WHERE User='\$MIG_USER' AND Host<>'127\.0\.0\.1'/);
  assert.match(source,/mysql\.proxies_priv WHERE User='\$APP_USER'/);
  assert.match(source,/mysql\.proxies_priv WHERE User='\$MIG_USER'/);
  assert.match(source,/runtime_granted_roles=%s expected=0/);
  assert.match(source,/runtime_alternate_host_accounts=%s expected=0/);
  assert.match(source,/migration_granted_roles=%s expected=0/);
  assert.match(source,/migration_alternate_host_accounts=%s expected=0/);
});

test('self-hosted runner account must have no sudo command grants, not merely no NOPASSWD grant',()=>{
  assert.match(source,/sudo -l -U ghrunner/);
  assert.ok(source.includes(String.raw`grep -Eq '^[[:space:]]*\([^)]*\)[[:space:]]'`));
  assert.match(source,/ghrunner has sudo command grants/);
  assert.match(source,/Could not reliably inspect ghrunner sudo policy/);
  assert.doesNotMatch(source,/grep -q NOPASSWD/);
});

test('any remaining privileged helper must be root-owned and not writable or setuid/setgid by non-root users',()=>{
  assert.match(source,/stat -c '%U:%G' \/usr\/local\/sbin\/istore-admin/);
  assert.match(source,/== "root:root"/);
  assert.match(source,/find \/usr\/local\/sbin\/istore-admin -maxdepth 0 -perm \/6022/);
});


test('production host preflight requires a dedicated service identity and effective systemd sandbox controls',()=>{
  for(const value of [
    'SERVICE_USER="$(systemctl show "$SERVICE" -p User --value',
    'SERVICE_GROUP="$(systemctl show "$SERVICE" -p Group --value',
    '[[ "$SERVICE_USER" == "ustorebot" ]] || fail',
    '[[ "$SERVICE_GROUP" == "ustorebot" ]] || fail',
    '[[ "$NO_NEW_PRIVILEGES" == "yes" ]] || fail',
    '[[ "$PRIVATE_TMP" == "yes" ]] || fail',
    '[[ "$PROTECT_SYSTEM" == "full" ]] || fail',
    '[[ "$PROTECT_HOME" == "yes" ]] || fail',
    'systemd ReadWritePaths must explicitly allow the active release path',
    'ustorebot:ustorebot:600'
  ]) assert.ok(source.includes(value), 'missing host hardening assertion: '+value);
});
