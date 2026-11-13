#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
REPO="https://github.com/farjam2014/istore-lottery-bot.git"
BRANCH="feature/telegram-account-recovery"
APP_DIR="/opt/istore-lottery-bot"
SERVICE="istore-lottery-bot"
DB_NAME="istore_lottery"
DB_USER="istore_lottery"
STAGE_DIR="/opt/.istore-lottery-preflight-${BASHPID}"
log(){ printf '\n[iStore] %s\n' "$*"; }
die(){ echo "[ERROR] $*" >&2; exit 1; }
trap 'rc=$?; [[ $rc -eq 0 ]] || echo "نصب کامل نشد؛ فایل پیش‌آزمون در $STAGE_DIR باقی مانده و کد خطا: $rc" >&2' EXIT
[[ $EUID -eq 0 ]] || die "با root یا sudo اجرا کنید."
[[ "$APP_DIR" == "/opt/istore-lottery-bot" && "$DB_NAME" == "istore_lottery" ]] || die "مسیرهای نصب غیرمنتظره‌اند."
. /etc/os-release
[[ "$ID" == ubuntu && "$(cut -d. -f1 <<< "$VERSION_ID")" == 24 ]] || die "فقط Ubuntu 24 پشتیبانی می‌شود."
cat <<'NOTICE'
نصب تازه و غیرمخرب: دیتابیس موجود حذف نمی‌شود. نصب فقط روی دیتابیس خالی انجام می‌شود؛ دیتابیس دارای جدول یا داده دست‌نخورده می‌ماند.
NOTICE
read -r -p "دامنه (مثلاً example.com): " DOMAIN
read -r -p "ایمیل دریافت SSL: " EMAIL
read -r -s -p "Telegram Bot Token: " BOT_TOKEN
echo
read -r -p "Telegram numeric Admin ID: " ADMIN_ID
read -r -p "شماره تماس فروشگاه با کد کشور (اختیاری): " CONTACT_PHONE
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || die "دامنه نامعتبر است."
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "ایمیل نامعتبر است."
[[ "$BOT_TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{20,}$ ]] || die "توکن نامعتبر است."
[[ "$ADMIN_ID" =~ ^[0-9]{5,20}$ ]] || die "Admin ID نامعتبر است."
if [[ -n "$CONTACT_PHONE" && ! "$CONTACT_PHONE" =~ ^\+?[0-9]{8,15}$ ]]; then die "شماره تماس نامعتبر است."; fi
SERVER_IP="$(hostname -I | awk '{print $1}')"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
[[ -n "$DNS_IP" && "$DNS_IP" == "$SERVER_IP" ]] || die "دامنه باید به IP همین سرور اشاره کند (DNS=$DNS_IP / Server=$SERVER_IP)."
log "نصب پیش‌نیازها"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git nginx mysql-server certbot python3-certbot-nginx jq openssl
if ! command -v node >/dev/null || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)' || die "Node.js 20+ لازم است."
systemctl enable --now mysql nginx
log "اعتبارسنجی توکن تلگرام"
ME="$(curl -fsS --max-time 20 "https://api.telegram.org/bot$BOT_TOKEN/getMe" || true)"
[[ "$(printf '%s' "$ME" | jq -r '.ok // false')" == true ]] || die "توکن تلگرام معتبر نیست."
BOT_USERNAME="$(printf '%s' "$ME" | jq -r '.result.username')"
log "دریافت نسخه و آزمون کامل پیش از هر تغییر مخرب"
[[ ! -e "$STAGE_DIR" ]] || die "مسیر پیش‌آزمون از قبل وجود دارد: $STAGE_DIR"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$STAGE_DIR"
cd "$STAGE_DIR"
npm ci --omit=dev
env -u MYSQL_TEST_HOST -u MYSQL_TEST_USER -u MYSQL_TEST_PASSWORD -u MYSQL_TEST_PORT npm test
log "آزمون‌ها موفق بودند؛ اکنون نصب آماده مرحله جایگزینی است"
DB_PASSWORD="$(openssl rand -hex 32)"
ADMIN_PASSWORD="$(openssl rand -hex 32)"
WEBHOOK_SECRET="$(openssl rand -hex 32)"
SESSION_SECRET="$(openssl rand -hex 48)"
log "ایجاد دیتابیس در صورت نبودن؛ هیچ دیتابیسی حذف نمی‌شود"
DB_EXISTS="$(mysql --protocol=socket -uroot -Nse "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$DB_NAME'")"
if [[ "$DB_EXISTS" == "0" ]]; then
  mysql --protocol=socket -uroot <<SQL
CREATE DATABASE istore_lottery CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'istore_lottery'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON istore_lottery.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
else
  TABLE_COUNT="$(mysql --protocol=socket -uroot -Nse "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME'")"
  [[ "$TABLE_COUNT" == "0" ]] || die "دیتابیس $DB_NAME خالی نیست؛ برای جلوگیری از تغییر ناخواسته نصب متوقف شد."
  mysql --protocol=socket -uroot <<SQL
CREATE USER IF NOT EXISTS 'istore_lottery'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER 'istore_lottery'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON istore_lottery.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
fi
log "توقف سرویس قبلی"
systemctl disable --now "$SERVICE" 2>/dev/null || true
log "جایگزینی نسخه آزموده‌شده در مسیر اصلی برنامه"
if [[ -e "$APP_DIR" || -L "$APP_DIR" ]]; then
  [[ "$APP_DIR" == "/opt/istore-lottery-bot" ]] || die "مسیر جابه‌جایی نامعتبر است."
  mv "$APP_DIR" "/opt/istore-lottery-previous-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mv "$STAGE_DIR" "$APP_DIR"
cd "$APP_DIR"
log "ساخت فایل محرمانه .env"
cat > "$APP_DIR/.env" <<ENV
BOT_TOKEN=$BOT_TOKEN
WEBHOOK_SECRET=$WEBHOOK_SECRET
ADMIN_PASSWORD=$ADMIN_PASSWORD
SESSION_SECRET=$SESSION_SECRET
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
ADMIN_ID=$ADMIN_ID
CONTACT_PHONE=$CONTACT_PHONE
PUBLIC_SITE_URL=https://$DOMAIN
ENV
chmod 600 "$APP_DIR/.env"
if ! id istorebot >/dev/null 2>&1; then useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin istorebot; fi
chown -R root:istorebot "$APP_DIR"
chmod -R g+rX "$APP_DIR"
chmod 640 "$APP_DIR/.env"
log "ساخت جداول دیتابیس تازه"
npm run migrate
log "ساخت سرویس systemd"
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=iStore Lottery Telegram Bot
After=network-online.target mysql.service
Wants=network-online.target
[Service]
Type=simple
User=istorebot
Group=istorebot
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP_DIR/src/index.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=70
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE"
log "تنظیم Nginx و SSL"
cat > "/etc/nginx/sites-available/$SERVICE" <<NGINX
server {
 listen 80;
 listen [::]:80;
 server_name $DOMAIN;
 client_max_body_size 2m;
 location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_read_timeout 60s;
 }
}
NGINX
ln -sfn "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
nginx -t
systemctl reload nginx
certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" -d "$DOMAIN"
log "راه‌اندازی سرویس جدید پیش از ثبت Webhook"
systemctl start "$SERVICE"

log "ثبت Webhook تلگرام"
WEBHOOK_URL="https://$DOMAIN/telegram/$WEBHOOK_SECRET"
WH="$(curl -fsS --max-time 30 -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  --data-urlencode "url=$WEBHOOK_URL" \
  --data-urlencode "secret_token=$WEBHOOK_SECRET" \
  --data-urlencode 'allowed_updates=["message","business_message","business_connection","callback_query"]')"
[[ "$(printf '%s' "$WH" | jq -r '.ok // false')" == true ]] || die "ثبت webhook ناموفق: $(printf '%s' "$WH" | jq -r '.description // "unknown"')"
for _ in $(seq 1 30); do
  curl -fsS --max-time 3 http://127.0.0.1:3000/health | jq -e '.ok == true and .database == "connected"' >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --max-time 5 http://127.0.0.1:3000/health | jq -e '.ok == true and .database == "connected"' >/dev/null || {
  journalctl -u "$SERVICE" -n 80 --no-pager
  die "Health check شکست خورد."
}
unset BOT_TOKEN DB_PASSWORD ADMIN_PASSWORD WEBHOOK_SECRET SESSION_SECRET
printf '\nنصب موفق بود.\nدامنه: https://%s\nربات: @%s\nپنل: https://%s/admin/login\nثبت‌نام: بسته\nسرویس: systemctl status %s\nگزارش: journalctl -u %s -f\nرمز تصادفی پنل و دیتابیس فقط در %s/.env ذخیره شده‌اند؛ فایل را منتشر نکنید.\n' "$DOMAIN" "$BOT_USERNAME" "$DOMAIN" "$SERVICE" "$SERVICE" "$APP_DIR"
