# Admin roles and authorization

The first configured super-admins are the numeric Telegram IDs in \`BOT_ADMIN_IDS\`.
They are treated as super-admins from environment configuration and cannot be downgraded from the Telegram UI. Keep this variable limited to trusted owners.

Additional staff are stored in \`admin_users\` and are managed from the inline menu:
**Admin → Management → Admins and roles**. Only a configured super-admin can assign, change, or deactivate staff roles.

| Role | Permissions |
| --- | --- |
| Super admin | All actions; role administration |
| Campaign manager | Campaign creation and management; participant read-only |
| Finance manager | Receipt review, payment settings, payment queue, financial reports; participant read-only |
| Support agent | Ticket queue, assignment, replies and status/priority management; participant read-only |

Participant blocking/unblocking and role administration remain super-admin-only.

Authorization is checked server-side for callback actions and text/photo workflows. Unknown admin callbacks fail closed. A role assignment is recorded in \`admin_role_events\`.

## Deployment notes

1. Set \`BOT_ADMIN_IDS\` to one or more trusted numeric Telegram IDs before deployment.
2. Apply the additive migration \`20261114_004_admin_roles.sql\` through the normal deployment migration process.
3. Open the admin panel as a configured super-admin and assign staff roles.
4. Verify each role with a separate Telegram account before relying on it operationally.

Do not remove the last trusted ID from \`BOT_ADMIN_IDS\` until another verified super-admin is configured. Existing role assignments are not automatically promoted to super-admin.
