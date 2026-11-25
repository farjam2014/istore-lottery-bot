# GitHub and Runner Security

## Repository workflow policy

- The repository is Public; the owner must confirm that public visibility is intentional.
- The inspected `main` branch contains only `.github/workflows/tests.yml`, using GitHub-hosted `ubuntu-latest` and immutable action commit pins.
- The `release/ustore-unified` branch contains only `.github/workflows/ci.yml`; it also uses GitHub-hosted runners and immutable action pins.
- PR #82 was merged as `7ef2c2a4aac46add9e0c5f92cd0c7f2aaf58626f`, removing the legacy VPS diagnostics workflows.
- PR #86 was merged as `905c37da8bc95689615f7cdd9368a77a2e632a1b`, removing the remaining VPS operations workflow.
- The currently inspected `main` and `release/ustore-unified` workflow sets do not target a Production self-hosted runner.

## Host-side runner release gate

Removing workflow YAML does **not** unregister a runner, stop its service, or revoke any host-side sudo rule. Before Production release, independently verify that no self-hosted runner remains registered or online for this repository, disable/unregister any Production-hosted runner, and remove or tightly restrict any privileged service-management helper it could invoke.

Host-specific runner names, paths, sudo rules, and command details belong in the private deployment audit evidence, not this public repository.

Do not restore any workflow that targets a Production host or self-hosted runner.

## Required GitHub repository controls

Before release, enable branch protection/rulesets for `main` and `release/ustore-unified`:

- Require pull requests before merging.
- Require at least one independent approval.
- Require the exact CI status check and require the branch to be up to date.
- Require review conversations to be resolved.
- Block force pushes and branch deletion.
- Restrict bypass permissions to a documented break-glass role.

Because the repository is Public, perform a full-history secret scan (for example, Gitleaks) and a credential-rotation review before release. Rotate any Telegram token, database password, encryption key, or other credential that was ever committed, even if the file was later deleted. Keep scan output and rotation evidence in a private audit record.

## Workflow policy

- Use GitHub-hosted `ubuntu-latest` runners only.
- Pin every third-party action to a reviewed full commit SHA.
- Grant the minimum workflow token permissions; default to read-only.
- Never expose Production credentials to pull-request workflows.
- Never let CI run database migrations, restart services, or execute host administration commands.
