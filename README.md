# iStore Lottery

Telegram Business lottery bot with MySQL, durable webhook inbox, Telegram-first admin tools, and a web admin interface.

## Safe install / upgrade — Ubuntu 24.04

> **Safe install/upgrade:** this installer does not drop application databases. If `istore_lottery` exists, it creates and verifies a compressed backup under `/var/backups/istore-lottery/` before schema changes. Existing application files are moved to a timestamped backup directory rather than deleted.

Run on the VPS to install the current tested feature branch:

```bash
curl -fsSL https://raw.githubusercontent.com/farjam2014/istore-lottery-bot/feature/complete-telegram-lottery-system/install.sh -o /root/istore-install.sh
sudo bash /root/istore-install.sh
```

It interactively asks for domain, SSL email, BotFather token, numeric Telegram admin ID, MySQL password, website admin-panel password, and optional store contact phone. Passwords are entered invisibly and must be confirmed; the MySQL password requires at least 20 characters and the panel password at least 16 characters. Webhook/session secrets are generated automatically. It verifies DNS and validates the bot token and validates the bot token before changing application configuration.

It installs Node.js 22, MySQL, Nginx, Certbot and Git; backs up an existing application database before schema changes; preserves the previous application directory; clones the configured feature branch; runs dependency install, tests, schema import and migrations; generates DB credentials, webhook/session secrets and an admin panel password; configures systemd, HTTPS, Telegram webhook and health check. Registration stays closed.

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
- Shaparak/provider payment is not implemented. Manual card-to-card receipt review is available only in the multi-campaign development branch.
- Instagram JSON import and some advanced participant conversation flows are not implemented.
- Installer assumes Ubuntu 24.04, DNS pointing to this VPS, and reachable inbound ports 80/443.
- Complete real Telegram Business and admin acceptance tests before opening registration.

## Multi-campaign development (feature branch)

The `feature/multicampaign-architecture` branch adds an additive multi-campaign schema, Telegram campaign selection and registration, transactional campaign joins, campaign admin APIs/UI, and isolated campaign draws. It is not yet a production-ready release.

Before using this branch:
- Set `CAMPAIGN_CODE_SECRET` to a cryptographically random secret of at least 32 characters. Never commit it or paste it into chat.
- Keep `REGISTRATION_OPEN=false` until the full Telegram Business flow is acceptance-tested in a staging bot.
- Manual transfer is implemented in this branch: configure a 16-digit card number, cardholder name and unit price when creating a campaign. The participant chooses a quantity, sends a receipt photo in the Business chat, and the bot forwards it to the admin Telegram account with approve/reject actions. The total payment is unit price × requested quantity. All requested codes are issued only after admin approval and a receipt record exists. Small batches are sent as a message; large batches are delivered as a CSV document. The Telegram file identifiers are stored; the image itself remains hosted by Telegram.
- Free campaigns always issue exactly one code per participant. Paid campaigns accept either a per-participant code cap or no campaign-level cap (blank cap in the admin form). Each individual order is limited to 10,000 codes to prevent abuse and excessive bot messages; participants can make further paid orders while the campaign remains active and their configured total cap is not reached. Every paid code is a separate draw ticket.
- Shaparak/provider payments remain disabled.
- Participant Instagram IDs are canonicalized to lowercase without a leading `@` and globally unique in `participants`. The migration stops if it detects duplicate legacy Instagram IDs; resolve those profiles before retrying. Full names are not unique.
- The multi-campaign schema migration is repeatable. For a confirmed empty test database, the schema can be rebuilt if needed; never assume a production database is empty without checking it first.
- Do not use the existing installer to deploy this feature branch; it currently targets the legacy branch and performs broader host changes.

Admin panel campaign tools are available at `/admin` after the migration has been applied. Campaigns are created as drafts; they must be explicitly activated.
