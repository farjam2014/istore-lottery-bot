#!/usr/bin/env bash
set -Eeuo pipefail

REPO="https://github.com/farjam2014/istore-lottery-bot.git"
BRANCH="install/one-command-ubuntu"
APP_DIR="/opt/ustore-telegram-bot"
APP_USER="ustorebot"
SERVICE="ustore-telegram-bot"

log(){ printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail(){ printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'rc=$?; printf "\nInstallation stopped (exit %s). No existing database or service was intentionally deleted.\n" "$rc" >&2' ERR

[[ "$(id -u)" -eq 0 ]] || fail "Run with sudo."
[[ -r /etc/os-release ]] || fail "Cannot identify Linux distribution."
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || fail "Ubuntu only."
case "${VERSION_ID:-}" in 22.04|24.04) ;; *) fail "Supported Ubuntu versions: 22.04 and 24.04." ;; esac
[[ ! -e "$APP_DIR" ]] || fail "$APP_DIR already exists; refusing to overwrite it."
command -v systemctl >/dev/null 2>&1 || fail "systemd is required."
[[ -e /dev/tty ]] || fail "Interactive terminal required."

printf '\nUStore Telegram Bot — clean installation\n'
printf 'Creates a separate app directory and a new uniquely named database. Existing databases/services are not deleted.\n\n'
read -r -s -p "Telegram bot token: " BOT_TOKEN </dev/tty
printf '\n'
[[ "${#BOT_TOKEN}" -ge 30 && "$BOT_TOKEN" == *:* ]] || fail "Bot token format is invalid."
read -r -p "Numeric Telegram admin ID: " ADMIN_ID </dev/tty
[[ "$ADMIN_ID" =~ ^[0-9]{5,20}$ ]] || fail "Admin ID must contain 5–20 digits."

SUFFIX="$(openssl rand -hex 4)"
DB_NAME="ustore_bot_${SUFFIX}"
DB_USER="ustore_app_${SUFFIX}"
DB_PASSWORD="$(openssl rand -hex 32)"

log "Installing prerequisites: Git, Node.js 22, MySQL and OpenSSL."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssl mysql-server
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 22 ]] || fail "Node.js 22+ required."
systemctl enable --now mysql

log "Creating the dedicated service account and downloading application source."
[[ ! -e "$APP_DIR" ]] || fail "$APP_DIR appeared during installation; refusing to overwrite."
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
git clone --depth 1 --single-branch --branch "$BRANCH" "$REPO" "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Installing dependencies and running tests."
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && npm install --omit=dev"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && npm test"

log "Creating a new isolated MySQL database and restricted user."
DB_EXISTS="$(mysql --batch --skip-column-names -e "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$DB_NAME'")"
[[ "$DB_EXISTS" == "0" ]] || fail "Generated database already exists; refusing to touch it."
mysql <<SQL
CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

log "Writing protected configuration and applying database schema."
umask 077
cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
BOT_TOKEN=$BOT_TOKEN
BOT_MODE=polling
BOT_ADMIN_IDS=$ADMIN_ID
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=$DB_NAME
MYSQL_USER=$DB_USER
MYSQL_PASSWORD=$DB_PASSWORD
MYSQL_POOL_SIZE=10
LOG_LEVEL=info
ENV
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
unset BOT_TOKEN
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && npm run db:migrate"

log "Installing and starting systemd service."
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
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
chmod 644 "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 3
if ! systemctl is-active --quiet "$SERVICE"; then
  systemctl --no-pager --full status "$SERVICE" || true
  fail "Service failed. Inspect: journalctl -u $SERVICE -n 100"
fi

log "Installation completed successfully."
printf '\nService:       %s\nApp directory: %s\nDatabase:      %s\nDB username:   %s\nDB password:   %s\n' "$SERVICE" "$APP_DIR" "$DB_NAME" "$DB_USER" "$DB_PASSWORD"
printf '\nCommands:\n  systemctl status %s\n  journalctl -u %s -f\n  systemctl restart %s\n' "$SERVICE" "$SERVICE" "$SERVICE"
printf '\nCredentials are stored in %s/.env (mode 600). Save the DB password now.\n' "$APP_DIR"
printf 'This release uses Telegram admin controls, not a web panel; no web-panel password exists.\n'
