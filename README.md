# iStore Lottery

Telegram Business lottery bot with MySQL, durable webhook inbox, Telegram-first admin tools, and a web admin interface.

## Install — Ubuntu 24.04 staging server

Run the installer on the VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/farjam2014/istore-lottery-bot/feature/multi-campaign-platform/install.sh -o /root/istore-install.sh
sudo bash /root/istore-install.sh
```

The installer asks for the domain, SSL email, Telegram BotFather token, numeric Telegram admin ID, and optional store contact details / Telegram URL. It does **not** ask you to choose either password.

A cryptographically random 32-byte MySQL password and a separate random 32-byte admin-panel password are generated automatically. They are not printed in the terminal. Both are stored in `/opt/istore-lottery-bot/.env`; the file is owned by root and the service group with mode `640`, so only root and the bot service can read it. The generated webhook and session secrets are also stored there. Do not share or commit this file.

**Destructive fresh reinstall:** no database backup is created. The installer stops and disables the existing `istore-lottery-bot` service, then asks for the exact confirmation phrase `DELETE istore_lottery`. Only after that confirmation, it permanently drops the `istore_lottery` database and its local MySQL user, recreates both with fresh credentials, imports `schema.sql`, and runs migrations. If the phrase is not entered exactly, the installer exits before dropping the database. Existing application files are moved to a timestamped directory and the new branch is cloned into `/opt/istore-lottery-bot`. The same systemd service, Nginx site, domain, and Telegram bot token/webhook are reconfigured for the new version. This is destructive and must only be used when all data in that database can be discarded.

The installer targets the `feature/multi-campaign-platform` branch, installs Node.js 22, MySQL, Nginx and Certbot, configures systemd and HTTPS, registers the Telegram webhook, and verifies the local health endpoint. Registration remains closed.

## Operations

```bash
sudo systemctl status istore-lottery-bot
sudo journalctl -u istore-lottery-bot -f
curl -fsS https://YOUR_DOMAIN/health
```

Send `/panel` to the bot from the configured admin account for Telegram admin controls.

## Participant accounts and Telegram password recovery

- Participant portal: `/account.html` supports phone/password registration and login. Registration requires an active participant profile and a prior private `/start` to the bot from the same Telegram account.
- Password recovery requests are sent to the configured admin in Telegram for approval. Approval sends a one-time reset link to the user's private bot chat; links expire after 15 minutes.
- Set `PUBLIC_SITE_URL` in `.env` to the site's HTTPS origin. The installer writes this automatically for fresh installations.

## Known limitations

- Telegram Bot API cannot verify Instagram follows live or determine whether a user saved a phone number in contacts.
- Manual card-to-card payment with receipt review is implemented; an online payment-gateway adapter and provider verification are not implemented yet.
- The website currently provides the admin interface; a shared participant account and participant-facing website are planned, not implemented.
- Instagram JSON import and some advanced participant conversation flows are not implemented.
- Installer assumes Ubuntu 24.04, DNS pointing to this VPS, and reachable inbound ports 80/443.
- Complete real Telegram Business and admin acceptance tests before opening registration.
