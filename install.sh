#!/usr/bin/env bash
set -Eeuo pipefail

REPO="https://github.com/farjam2014/istore-lottery-bot.git"
APP_DIR="/opt/ustore-telegram-bot"
APP_USER="ustorebot"
SERVICE="ustore-telegram-bot"
ENV_FILE="$APP_DIR/.env"
MIGRATION_ENV_DIR="/etc/ustore-telegram-bot"
MIGRATION_ENV_FILE="$MIGRATION_ENV_DIR/ustore-telegram-bot-migration.env"
RELEASE_COMMIT="${USTORE_RELEASE_COMMIT:-}"

log(){ printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail(){ printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'rc=$?; printf "\nInstaller stopped (exit %s). Existing databases and unrelated services were not deleted.\n" "$rc" >&2' ERR

[[ "$(id -u)" -eq 0 ]] || fail "Run with sudo/root."
[[ -r /etc/os-release ]] || fail "Cannot identify Linux distribution."
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || fail "Ubuntu only."
case "${VERSION_ID:-}" in 22.04|24.04) ;; *) fail "Supported Ubuntu versions: 22.04 and 24.04." ;; esac
command -v systemctl >/dev/null 2>&1 || fail "systemd is required."
[[ -e /dev/tty ]] || fail "An interactive terminal is required."
[[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "Set USTORE_RELEASE_COMMIT to the exact reviewed 40-character release commit SHA."

# Refuse to touch an active service whose effective runtime points elsewhere.
if systemctl is-active --quiet "$SERVICE"; then
  active_user="$(systemctl show "$SERVICE" -p User --value)"
  active_working_dir="$(systemctl show "$SERVICE" -p WorkingDirectory --value)"
  active_exec_start="$(systemctl show "$SERVICE" -p ExecStart --value)"
  [[ "$active_user" == "$APP_USER" ]] || fail "Active $SERVICE runs as '$active_user', expected '$APP_USER'; refusing to stop it."
  [[ "$active_working_dir" == "$APP_DIR" ]] || fail "Active $SERVICE uses WorkingDirectory '$active_working_dir', not '$APP_DIR'; refusing to stop it."
  [[ "$active_exec_start" == *"$APP_DIR/src/index.js"* ]] || fail "Active $SERVICE ExecStart does not target '$APP_DIR/src/index.js'; refusing to stop it."
fi

# Validate any existing unit file before provisioning, checkout updates, or service stop.
UNIT_FILE="/etc/systemd/system/$SERVICE.service"
if [[ -e "$UNIT_FILE" ]]; then
  grep -Fq "User=$APP_USER" "$UNIT_FILE" || fail "An unrelated $SERVICE.service already exists; refusing to overwrite it."
  grep -Fq "WorkingDirectory=$APP_DIR" "$UNIT_FILE" || fail "Existing $SERVICE.service points to a different directory."
  grep -Fq "ExecStart=/usr/bin/node $APP_DIR/src/index.js" "$UNIT_FILE" || fail "Existing $SERVICE.service has an unexpected ExecStart."
fi

log "Installing prerequisites."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssl mysql-server
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 22 ]] || fail "Node.js 22+ is required."
systemctl enable --now mysql

log "Preparing the application account and source checkout."
if ! id "$APP_USER" >/dev/null 2>&1; then
  if [[ -e "$APP_DIR" ]]; then
    fail "$APP_DIR exists but service account $APP_USER is missing; refusing to change ownership automatically."
  fi
  useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

UPDATE_EXISTING=0
if [[ ! -e "$APP_DIR" ]]; then
  git clone --no-checkout --depth 1 "$REPO" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
else
  [[ -d "$APP_DIR/.git" ]] || fail "$APP_DIR exists but is not a Git checkout; move it manually after reviewing its contents."
  owner="$(stat -c '%U' "$APP_DIR")"
  [[ "$owner" == "$APP_USER" ]] || fail "$APP_DIR is owned by '$owner', expected '$APP_USER'; refusing automatic chown."
  remote="$(runuser -u "$APP_USER" -- git -C "$APP_DIR" remote get-url origin)"
  [[ "$remote" == "$REPO" ]] || fail "Existing checkout has an unexpected origin remote; refusing to update it."
  tracked_changes="$(runuser -u "$APP_USER" -- git -C "$APP_DIR" status --porcelain --untracked-files=all)"
  [[ -z "$tracked_changes" ]] || fail "Tracked or untracked files are present in the checkout. Inspect and preserve them before updating."
  UPDATE_EXISTING=1
  log "Existing checkout validated; source update is deferred until after service-stop authorization checks."
fi

[[ -f "$APP_DIR/package.json" && -f "$APP_DIR/src/index.js" ]] || fail "Application source is incomplete."

read_env(){ sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
if [[ ! -e "$ENV_FILE" ]]; then
  printf '\nUStore Telegram Bot — resumable installation\n'
  printf 'The installer reuses this checkout when it matches the expected repository. Existing databases are never dropped.\n\n'
  read -r -s -p "Telegram bot token: " BOT_TOKEN </dev/tty
  printf '\n'
  [[ "${#BOT_TOKEN}" -ge 30 && "$BOT_TOKEN" == *:* ]] || fail "Telegram bot token format is invalid."
  read -r -p "Numeric Telegram admin ID: " ADMIN_ID </dev/tty
  [[ "$ADMIN_ID" =~ ^[0-9]{5,20}$ ]] || fail "Admin ID must contain 5–20 digits."
  read -r -p "Published HTTPS privacy notice URL: " PRIVACY_NOTICE_URL </dev/tty
  node --input-type=module -e 'const value=process.argv[1];let u;try{u=new URL(value)}catch{process.exit(1)}const h=u.hostname;if(u.protocol!=="https:"||["example.com","www.example.com","localhost"].includes(h)||h.endsWith(".example")||h.endsWith(".test")||h.endsWith(".invalid"))process.exit(1)' "$PRIVACY_NOTICE_URL" || fail "A published, non-placeholder HTTPS privacy notice URL is required."
  read -r -p "Privacy notice version: " PRIVACY_NOTICE_VERSION </dev/tty
  [[ "$PRIVACY_NOTICE_VERSION" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || fail "Privacy notice version must be 1–40 letters, digits, dots, underscores, or hyphens."

  suffix="$(openssl rand -hex 6)"
  DB_NAME="ustore_bot_${suffix}"
  DB_USER="ustore_app_${suffix}"
  DB_PASSWORD="$(openssl rand -hex 32)"
  MIGRATION_DB_USER="ustore_migrate_${suffix}"
  MIGRATION_DB_PASSWORD="$(openssl rand -hex 32)"
  DRAW_SEED_KEY="$(openssl rand -hex 32)"
  umask 077
  tmp_env="$(mktemp "$APP_DIR/.env.XXXXXX")"
  cat > "$tmp_env" <<ENV
NODE_ENV=production
BOT_TOKEN=$BOT_TOKEN
BOT_ADMIN_IDS=$ADMIN_ID
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=$DB_NAME
MYSQL_USER=$DB_USER
MYSQL_PASSWORD=$DB_PASSWORD
MYSQL_POOL_SIZE=5
LOG_LEVEL=info
DRAW_SEED_ENCRYPTION_KEY=$DRAW_SEED_KEY
PRIVACY_NOTICE_URL=$PRIVACY_NOTICE_URL
PRIVACY_NOTICE_VERSION=$PRIVACY_NOTICE_VERSION
ENV
  chown "$APP_USER:$APP_USER" "$tmp_env"
  chmod 600 "$tmp_env"
  mv "$tmp_env" "$ENV_FILE"
  unset BOT_TOKEN DB_PASSWORD MIGRATION_DB_PASSWORD DRAW_SEED_KEY PRIVACY_NOTICE_URL PRIVACY_NOTICE_VERSION
else
  log "Existing .env found; preserving it and not prompting for or printing secrets."
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail ".env must be a regular file, not a symlink."
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

DB_NAME="$(read_env MYSQL_DATABASE)"
DB_USER="$(read_env MYSQL_USER)"
DB_PASSWORD="$(read_env MYSQL_PASSWORD)"
DB_HOST="$(read_env MYSQL_HOST)"
BOT_TOKEN="$(read_env BOT_TOKEN)"
ADMIN_ID="$(read_env BOT_ADMIN_IDS)"
PRIVACY_NOTICE_URL="$(read_env PRIVACY_NOTICE_URL)"
PRIVACY_NOTICE_VERSION="$(read_env PRIVACY_NOTICE_VERSION)"
RUNTIME_MIGRATION_USER="$(read_env MYSQL_MIGRATION_USER)"
RUNTIME_MIGRATION_PASSWORD="$(read_env MYSQL_MIGRATION_PASSWORD)"
DRAW_SEED_ENCRYPTION_KEY="$(read_env DRAW_SEED_ENCRYPTION_KEY)"
DRAW_SEED_ENCRYPTION_KEYS="$(read_env DRAW_SEED_ENCRYPTION_KEYS)"
NODE_ENV_VALUE="$(read_env NODE_ENV)"
NODE_ENV_VALUE="${NODE_ENV_VALUE:-production}"
[[ "$NODE_ENV_VALUE" == "production" ]] || fail "Production installer requires NODE_ENV=production; refusing non-production configuration."

# The installer provisions MySQL and applies schema changes. Require explicit,
# target-bound authorization before any database or MySQL-account operation.
[[ "${ALLOW_DATABASE_MIGRATIONS:-}" == "1" ]] || fail "Database provisioning and migrations are disabled by default. Set ALLOW_DATABASE_MIGRATIONS=1 only after explicit approval."
[[ "${ALLOW_PRODUCTION_MIGRATIONS:-}" == "1" ]] || fail "Production database changes additionally require ALLOW_PRODUCTION_MIGRATIONS=1."
requested_migration_target="${MIGRATION_TARGET_DATABASE:-$DB_NAME}"
[[ "$requested_migration_target" == "$DB_NAME" ]] || fail "MIGRATION_TARGET_DATABASE must exactly match MYSQL_DATABASE."
MIGRATION_TARGET_DATABASE="$DB_NAME"
[[ "$DB_NAME" =~ ^ustore_bot_([a-f0-9]{8}|[a-f0-9]{12})$ ]] || fail "MYSQL_DATABASE in .env is not a generated UStore database name."
DB_SUFFIX="${BASH_REMATCH[1]}"
[[ "$DB_USER" == "ustore_app_${DB_SUFFIX}" ]] || fail "MYSQL_USER must match the generated database suffix."
[[ "$DB_PASSWORD" =~ ^[a-f0-9]{64}$ ]] || fail "MYSQL_PASSWORD in .env must be the generated 64-character hex password."

# Migration credentials are deliberately kept outside the service-readable .env.
if [[ -e "$MIGRATION_ENV_DIR" ]]; then
  [[ -d "$MIGRATION_ENV_DIR" && ! -L "$MIGRATION_ENV_DIR" ]] || fail "Migration credential directory must be a real directory, not a symlink."
  [[ "$(stat -c '%U:%G:%a' "$MIGRATION_ENV_DIR")" == "root:root:700" ]] || fail "Migration credential directory must be root:root mode 700."
else
  install -d -o root -g root -m 700 "$MIGRATION_ENV_DIR"
fi
if [[ -e "$MIGRATION_ENV_FILE" ]]; then
  [[ -f "$MIGRATION_ENV_FILE" && ! -L "$MIGRATION_ENV_FILE" ]] || fail "Migration credential file must be a regular file, not a symlink."
  [[ "$(stat -c '%U:%G:%a' "$MIGRATION_ENV_FILE")" == "root:root:600" ]] || fail "Migration credential file must be root:root mode 600."
  MIGRATION_DB_USER="$(sed -n 's/^MYSQL_MIGRATION_USER=//p' "$MIGRATION_ENV_FILE" | head -n 1)"
  MIGRATION_DB_PASSWORD="$(sed -n 's/^MYSQL_MIGRATION_PASSWORD=//p' "$MIGRATION_ENV_FILE" | head -n 1)"
  MIGRATION_FILE_TARGET_DATABASE="$(sed -n 's/^MIGRATION_TARGET_DATABASE=//p' "$MIGRATION_ENV_FILE" | head -n 1)"
else
  MIGRATION_DB_USER="ustore_migrate_${DB_SUFFIX}"
  MIGRATION_DB_PASSWORD="$(openssl rand -hex 32)"
  MIGRATION_FILE_TARGET_DATABASE="$DB_NAME"
  tmp_migration_env="$(mktemp "$MIGRATION_ENV_DIR/.migration.XXXXXX")"
  cat > "$tmp_migration_env" <<MIGRATION_ENV
MYSQL_MIGRATION_USER=$MIGRATION_DB_USER
MYSQL_MIGRATION_PASSWORD=$MIGRATION_DB_PASSWORD
MIGRATION_TARGET_DATABASE=$MIGRATION_FILE_TARGET_DATABASE
MIGRATION_ENV
  chown root:root "$tmp_migration_env"
  chmod 600 "$tmp_migration_env"
  mv "$tmp_migration_env" "$MIGRATION_ENV_FILE"
fi
[[ "$MIGRATION_DB_USER" == "ustore_migrate_${DB_SUFFIX}" ]] || fail "Migration account name must match this database's generated suffix."
[[ "$MIGRATION_DB_PASSWORD" =~ ^[a-f0-9]{64}$ ]] || fail "Migration password must be a generated 64-character hex password."
[[ "$MIGRATION_DB_USER" != "$DB_USER" ]] || fail "Runtime and migration database accounts must be distinct."
[[ -z "$RUNTIME_MIGRATION_USER" && -z "$RUNTIME_MIGRATION_PASSWORD" ]] || fail "Migration credentials must not be stored in the service-readable runtime .env."
unset RUNTIME_MIGRATION_PASSWORD
[[ "$MIGRATION_FILE_TARGET_DATABASE" == "$DB_NAME" ]] || fail "Protected migration file targets a different database."
[[ "$DB_HOST" == 127.0.0.1 ]] || fail "This installer expects MYSQL_HOST=127.0.0.1."
[[ "${#BOT_TOKEN}" -ge 30 && "$BOT_TOKEN" == *:* ]] || fail "BOT_TOKEN in .env is missing or invalid."
admin_ids_csv="${ADMIN_ID//[[:space:]]/}"
[[ "$admin_ids_csv" =~ ^[0-9]{5,20}(,[0-9]{5,20})*$ ]] || fail "BOT_ADMIN_IDS in .env must be a comma-separated list of numeric Telegram IDs."
node --input-type=module -e 'const value=process.argv[1];let u;try{u=new URL(value)}catch{process.exit(1)}const h=u.hostname;if(u.protocol!=="https:"||["example.com","www.example.com","localhost"].includes(h)||h.endsWith(".example")||h.endsWith(".test")||h.endsWith(".invalid"))process.exit(1)' "$PRIVACY_NOTICE_URL" || fail "PRIVACY_NOTICE_URL must be a published, non-placeholder HTTPS URL."
[[ "$PRIVACY_NOTICE_VERSION" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || fail "PRIVACY_NOTICE_VERSION in .env is missing or invalid."
[[ -n "$DRAW_SEED_ENCRYPTION_KEY" || -n "$DRAW_SEED_ENCRYPTION_KEYS" ]] || fail "Draw encryption key is missing. Add DRAW_SEED_ENCRYPTION_KEY (64 hex characters) or a valid DRAW_SEED_ENCRYPTION_KEYS keyring to .env; existing installations are never assigned a replacement key automatically."

# Validate the existing service target before any stop/update operation.

if systemctl is-active --quiet "$SERVICE"; then
  log "Stopping the active application service before changing source files or database schema."
  systemctl stop "$SERVICE"
fi
if [[ "$UPDATE_EXISTING" == "1" ]]; then
  log "Updating the existing checkout after the service has stopped."
fi
log "Fetching the exact reviewed release commit."
runuser -u "$APP_USER" -- git -C "$APP_DIR" fetch --depth 1 origin "$RELEASE_COMMIT"
fetched_commit="$(runuser -u "$APP_USER" -- git -C "$APP_DIR" rev-parse FETCH_HEAD)"
[[ "$fetched_commit" == "$RELEASE_COMMIT" ]] || fail "Fetched commit does not match USTORE_RELEASE_COMMIT."
runuser -u "$APP_USER" -- git -C "$APP_DIR" checkout --detach "$RELEASE_COMMIT"
checked_out_commit="$(runuser -u "$APP_USER" -- git -C "$APP_DIR" rev-parse HEAD)"
[[ "$checked_out_commit" == "$RELEASE_COMMIT" ]] || fail "Checked-out commit does not match USTORE_RELEASE_COMMIT."
log "Pinned source commit: $checked_out_commit"

log "Installing production dependencies and running automated tests."
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && npm ci --omit=dev"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && node --input-type=module -e \"import \\\"dotenv/config\\\"; import {loadDrawKeyring} from \\\"./src/modules/draw/draw-keyring.js\\\"; loadDrawKeyring();\""
unset DRAW_SEED_ENCRYPTION_KEY DRAW_SEED_ENCRYPTION_KEYS
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && npm test"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && find src tests -name '*.js' -print0 | xargs -0 -n1 node --check"


log "Ensuring the dedicated database and restricted application user exist. No database is dropped."
mysql <<SQL
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM '$DB_USER'@'127.0.0.1';
SET DEFAULT ROLE NONE TO '$DB_USER'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON $DB_NAME.* TO '$DB_USER'@'127.0.0.1';
CREATE USER IF NOT EXISTS '$MIGRATION_DB_USER'@'127.0.0.1' IDENTIFIED BY '$MIGRATION_DB_PASSWORD';
ALTER USER '$MIGRATION_DB_USER'@'127.0.0.1' IDENTIFIED BY '$MIGRATION_DB_PASSWORD';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM '$MIGRATION_DB_USER'@'127.0.0.1';
SET DEFAULT ROLE NONE TO '$MIGRATION_DB_USER'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON $DB_NAME.* TO '$MIGRATION_DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
unset DB_PASSWORD BOT_TOKEN

log "Applying versioned database migrations with the root-only migration account."
(
  set -a
  . "$MIGRATION_ENV_FILE"
  set +a
  [[ "$MYSQL_MIGRATION_USER" == "$MIGRATION_DB_USER" && "$MYSQL_MIGRATION_PASSWORD" == "$MIGRATION_DB_PASSWORD" && "$MIGRATION_TARGET_DATABASE" == "$DB_NAME" ]] || fail "Protected migration file does not match the provisioned account and target database."
  cd "$APP_DIR"
  ALLOW_DATABASE_MIGRATIONS=1 ALLOW_PRODUCTION_MIGRATIONS="${ALLOW_PRODUCTION_MIGRATIONS:-}" npm run db:migrate
)
unset MIGRATION_DB_PASSWORD MYSQL_MIGRATION_PASSWORD MYSQL_MIGRATION_USER

log "Installing and starting the systemd service."
tmp_unit="$(mktemp)"
cat > "$tmp_unit" <<UNIT
[Unit]
Description=UStore Telegram Bot
After=network-online.target mysql.service
Wants=network-online.target
Requires=mysql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP_DIR/src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
UNIT
install -o root -g root -m 0644 "$tmp_unit" "$UNIT_FILE"
rm -f "$tmp_unit"
systemctl daemon-reload
systemctl enable "$SERVICE"
STARTUP_LOG_SINCE="$(date --iso-8601=seconds)"
if systemctl is-active --quiet "$SERVICE"; then
  systemctl restart "$SERVICE"
else
  systemctl start "$SERVICE"
fi
startup_verified=0
for attempt in $(seq 1 20); do
  active_state="$(systemctl show "$SERVICE" --property=ActiveState --value)"
  sub_state="$(systemctl show "$SERVICE" --property=SubState --value)"
  main_pid="$(systemctl show "$SERVICE" --property=MainPID --value)"
  startup_log="$(journalctl -u "$SERVICE" --since "$STARTUP_LOG_SINCE" --no-pager 2>/dev/null || true)"
  if [[ "$active_state" == "active" && "$sub_state" == "running" && "$main_pid" =~ ^[1-9][0-9]*$ ]] && grep -Fq "Telegram bot launched with long polling" <<<"$startup_log"; then
    startup_verified=1
    break
  fi
  sleep 1
done
if [[ "$startup_verified" != "1" ]]; then
  systemctl --no-pager --full status "$SERVICE" || true
  journalctl -u "$SERVICE" --since "$STARTUP_LOG_SINCE" -n 100 --no-pager || true
  fail "Service did not reach running state with successful Telegram polling startup. Inspect: journalctl -u $SERVICE -n 100"
fi

log "Installation completed."
printf '\nService:       %s\nApp directory: %s\nDatabase:      %s\nDB username:   %s\n' "$SERVICE" "$APP_DIR" "$DB_NAME" "$DB_USER"
printf '\nUseful commands:\n  systemctl status %s\n  journalctl -u %s -f\n  systemctl restart %s\n' "$SERVICE" "$SERVICE" "$SERVICE"
printf '\nSecrets remain in %s/.env (owner %s, permissions 600); they are not printed.\n' "$APP_DIR" "$APP_USER"
printf 'Administration is currently inside Telegram; this release does not include a web panel or web-panel password.\n'
