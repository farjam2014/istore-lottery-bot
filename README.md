# iStore Lottery

Telegram Business lottery bot with MySQL, durable webhook inbox, Telegram-first admin tools, and a web admin interface.

## Clean install — Ubuntu 24.04

> **Destructive:** this installer permanently drops MySQL databases `istore_lottery` and `istore_lottery_staging`, including participants, raffle codes, sessions, draw history, and audit data. It also removes the old application directories and service.

Run on the VPS to install the current tested feature branch:

```bash
curl -fsSL https://raw.githubusercontent.com/farjam2014/istore-lottery-bot/feature/complete-telegram-lottery-system/install.sh -o /root/istore-install.sh
sudo bash /root/istore-install.sh
```

It interactively asks for domain, SSL email, BotFather token, numeric Telegram admin ID, MySQL password, website admin-panel password, and optional store contact phone. Passwords are entered invisibly and must be confirmed; the MySQL password requires at least 20 characters and the panel password at least 16 characters. Webhook/session secrets are generated automatically. It verifies DNS and validates the bot token before the destructive confirmation phrase `DELETE-ISTORE-ALL`.

It installs Node.js 22, MySQL, Nginx, Certbot and Git; clones the configured feature branch; runs dependency install, tests, schema import and migrations; generates DB credentials, webhook/session secrets and an admin panel password; configures systemd, HTTPS, Telegram webhook and health check. Registration stays closed.

The MySQL and admin-panel passwords are the values entered during installation. All credentials are stored in `/opt/istore-lottery-bot/.env` (mode 640, readable only by root and the service group). Webhook/session secrets are generated automatically. Never paste this file into chat or commit it.

## Operations

```bash
sudo systemctl status istore-lottery-bot
sudo journalctl -u istore-lottery-bot -f
curl -fsS https://YOUR_DOMAIN/health
```

Send `/panel` to the bot from the configured admin account for Telegram admin controls.

## Known limitations

- Telegram Bot API cannot verify Instagram follows live or determine whether a user saved a phone number in contacts.
- Real payment collection is not implemented.
- Instagram JSON import and some advanced participant conversation flows are not implemented.
- Installer assumes Ubuntu 24.04, DNS pointing to this VPS, and reachable inbound ports 80/443.
- Complete real Telegram Business and admin acceptance tests before opening registration.
