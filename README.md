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

No database backup is created. The installer does not drop the existing database; it creates it if absent, rotates the local application DB user's password, imports the schema using idempotent table creation, and runs migrations. Existing data may be affected by schema migrations, so this workflow is intended for the disposable staging environment, not production.

The installer targets the `feature/multi-campaign-platform` branch, installs Node.js 22, MySQL, Nginx and Certbot, configures systemd and HTTPS, registers the Telegram webhook, and verifies the local health endpoint. Registration remains closed.

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
