# GitHub and Runner Security

## Verified repository state — 2026-11-25

- Repository visibility is currently **Public**. The owner must confirm that this is intentional. A complete secret scan across all Git history has not been demonstrated by this audit; current-file searches are not a substitute.
- The current `main` branch contains only `.github/workflows/tests.yml`, which uses GitHub-hosted `ubuntu-latest` runners and immutable action commit pins.
- The `release/ustore-unified` branch contains only `.github/workflows/ci.yml`; it also uses GitHub-hosted runners and immutable action pins.
- PR #82 was merged as `7ef2c2a4aac46add9e0c5f92cd0c7f2aaf58626f`, removing the two legacy VPS diagnostics workflows.
- PR #86 was merged as `905c37da8bc95689615f7cdd9368a77a2e632a1b`, removing the remaining VPS operations workflow.
- Therefore, the currently inspected `main` and `release/ustore-unified` workflow sets do not target the Production self-hosted runner.

## Remaining host-side runner risk

The latest available read-only host audit snapshot, dated 2026-11-24, still showed the GitHub self-hosted runner service installed and active. It also showed a root-owned `/usr/local/sbin/istore-admin` helper reachable through passwordless sudo, with `status`, `health`, `start`, and `restart` actions.

Removing workflow YAML does **not** unregister the runner, stop its service, or revoke the sudo helper. The host state has not been re-queried after that snapshot.

Before Production release:

1. Disable and unregister the self-hosted runner from the host and GitHub repository.
2. Remove its passwordless sudo rule and helper, or reduce the helper to non-mutating `status`/`health` operations if a documented operational need remains.
3. Confirm the runner no longer appears online in repository Actions settings.
4. Do not restore any workflow that targets a Production host or self-hosted runner.

## Required GitHub repository controls

The GitHub API currently reports `protected=false` for both `main` and `release/ustore-unified`. These branches therefore do not enforce required reviews or status checks.

Before release, the repository owner should enable branch protection/rulesets for both branches:

- Require pull requests before merging.
- Require at least one independent approval.
- Require the exact CI status check and require the branch to be up to date.
- Require review conversations to be resolved.
- Block force pushes and branch deletion.
- Restrict bypass permissions to a documented break-glass role.

Because the repository is Public, run a full-history secret scan (for example, Gitleaks) before release. Rotate any Telegram token, database password, encryption key, or other credential that was ever committed, even if the file was later deleted. No comprehensive history scan or rotation was performed as part of this repository-only work.

## Workflow policy

- Use GitHub-hosted `ubuntu-latest` runners only.
- Pin every third-party action to a reviewed full commit SHA.
- Grant the minimum workflow token permissions; default to read-only.
- Never expose Production credentials to pull-request workflows.
- Never let CI run database migrations, restart services, or execute host administration commands.
