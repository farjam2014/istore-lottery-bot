#!/usr/bin/env bash
set -Eeuo pipefail

REPO="https://github.com/farjam2014/istore-lottery-bot.git"
BRANCH="install/resumable-ubuntu-v2"
APP_DIR="/opt/ustore-telegram-bot"
APP_USER="ustorebot"
SERVICE="ustore-telegram-bot"
ENV_FILE="$APP_DIR/.env"

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
  git clone --depth 1 --single-branch --branch "$BRANCH" "$REPO" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
else
  [[ -d "$APP_DIR/.git" ]] || fail "$APP_DIR exists but is not a Git checkout; move it manually after reviewing its contents."
  owner="$(stat -c '%U' "$APP_DIR")"
  [[ "$owner" == "$APP_USER" ]] || fail "$APP_DIR is owned by '$owner', expected '$APP_USER'; refusing automatic chown."
  remote="$(runuser -u "$APP_USER" -- git -C "$APP_DIR" remote get-url origin)"
  [[ "$remote" == "$REPO" ]] || fail "Existing checkout has an unexpected origin remote: $remote"
  tracked_changes="$(runuser -u "$APP_USER" -- git -C "$APP_DIR" status --porcelain --untracked-files=no)"
  [[ -z "$tracked_changes" ]] || fail "Tracked source files have local modifications. Commit or inspect them before updating."
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

  suffix="$(openssl rand -hex 6)"
  DB_NAME="ustore_bot_${suffix}"
  DB_USER="ustore_app_${suffix}"
  DB_PASSWORD="$(openssl rand -hex 32)"
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
ENV
  chown "$APP_USER:$APP_USER" "$tmp_env"
  chmod 600 "$tmp_env"
  mv "$tmp_env" "$ENV_FILE"
  unset BOT_TOKEN DB_PASSWORD DRAW_SEED_KEY
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
[[ "$DB_USER" =~ ^ustore_app_([a-f0-9]{8}|[a-f0-9]{12})$ ]] || fail "MYSQL_USER in .env is not a generated UStore database user."
[[ "$DB_PASSWORD" =~ ^[a-f0-9]{64}$ ]] || fail "MYSQL_PASSWORD in .env must be the generated 64-character hex password."
[[ "$DB_HOST" == 127.0.0.1 ]] || fail "This installer expects MYSQL_HOST=127.0.0.1."
[[ "${#BOT_TOKEN}" -ge 30 && "$BOT_TOKEN" == *:* ]] || fail "BOT_TOKEN in .env is missing or invalid."
[[ "$ADMIN_ID" =~ ^[0-9]{5,20}$ ]] || fail "BOT_ADMIN_IDS in .env must contain one numeric admin ID."
[[ -n "$DRAW_SEED_ENCRYPTION_KEY" || -n "$DRAW_SEED_ENCRYPTION_KEYS" ]] || fail "Draw encryption key is missing. Add DRAW_SEED_ENCRYPTION_KEY (64 hex characters) or a valid DRAW_SEED_ENCRYPTION_KEYS keyring to .env; existing installations are never assigned a replacement key automatically."

# Validate the existing service target before any stop/update operation.
UNIT_FILE="/etc/systemd/system/$SERVICE.service"
if [[ -e "$UNIT_FILE" ]]; then
  grep -Fq "User=$APP_USER" "$UNIT_FILE" || fail "An unrelated $SERVICE.service already exists; refusing to overwrite it."
  grep -Fq "WorkingDirectory=$APP_DIR" "$UNIT_FILE" || fail "Existing $SERVICE.service points to a different directory."
  grep -Fq "ExecStart=/usr/bin/node $APP_DIR/src/index.js" "$UNIT_FILE" || fail "Existing $SERVICE.service has an unexpected ExecStart."
fi

if systemctl is-active --quiet "$SERVICE"; then
  log "Stopping the active application service before changing source files or database schema."
  systemctl stop "$SERVICE"
fi
if [[ "$UPDATE_EXISTING" == "1" ]]; then
  log "Updating the existing checkout after the service has stopped."
  runuser -u "$APP_USER" -- git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  runuser -u "$APP_USER" -- git -C "$APP_DIR" checkout -B "$BRANCH" FETCH_HEAD
fi

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
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON $DB_NAME.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
unset DB_PASSWORD BOT_TOKEN

log "Applying versioned database migrations."
runuser -u "$APP_USER" -- env ALLOW_DATABASE_MIGRATIONS=1 ALLOW_PRODUCTION_MIGRATIONS="${ALLOW_PRODUCTION_MIGRATIONS:-}" MIGRATION_TARGET_DATABASE="${MIGRATION_TARGET_DATABASE:-}" bash -lc "cd '$APP_DIR' && npm run db:migrate"

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
