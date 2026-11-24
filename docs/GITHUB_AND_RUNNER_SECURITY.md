# GitHub Governance and Self-Hosted Runner Security

## Current audit status

The repository branch and ruleset inventory reviewed during this audit showed no enforced branch protection/ruleset on the critical branches. The VPS diagnostic workflow on the legacy main branch also uses a persistent self-hosted runner and must be treated as a privileged host-execution surface.

This document is a required configuration checklist. Repository settings and the actual runner host are not changed by a source-code PR.

## Required branch rules

Apply rules to:
- main
- release/ustore-unified
- remediation/release-hardening-release-base (and the final release branch)

Require:
- Pull requests before merge.
- At least one independent approval for production/release changes.
- Required CI checks on the exact proposed head SHA.
- Dismissal of stale approvals after new commits.
- Conversation resolution before merge.
- No force pushes and no branch deletion.
- Restrict who can bypass the rules; avoid broad administrator bypass.
- Require linear history if the repository's merge strategy supports it.

Do not treat a green check from an old commit as approval for a newer head SHA.

## GitHub Actions

- Set explicit minimal workflow permissions; the release CI workflow now uses contents: read.
- Pin third-party actions to verified full commit SHAs and use Dependabot/Renovate to update them.
- Keep CI on GitHub-hosted ephemeral runners.
- Do not expose production secrets to pull-request workflows.
- Restrict workflow_dispatch and deployment environments to named maintainers and protected refs.
- Use immutable commit SHAs as deployment inputs; never deploy a mutable branch name.
- Require an environment approval before production deployment.

## Persistent self-hosted runner

Before any self-hosted workflow is allowed to execute:
- Place the runner in a dedicated runner group restricted to this repository and trusted branches.
- Use an ephemeral or disposable runner; do not reuse a long-lived machine with ambient production credentials.
- Do not allow arbitrary repository writers to dispatch shell workflows on the runner.
- Remove broad sudo rights. The runner account should not be able to read application secrets, database backups, or unrelated host files.
- Review the exact source and argument validation of any sudo helper such as the reported istore-admin helper.
- Restrict outbound network access where feasible and record runner job provenance.
- Never print environment variables, credentials, .env contents, or unredacted host/user inventory in job logs.

## Legacy workflow requiring action

The legacy `vps-safe-diagnostics.yml` and `vps-readonly-diagnostics.yml` workflows were identified on `main`. Both execute on a persistent self-hosted runner through workflow dispatch. Their removal is prepared separately in Draft PR82 because these files live on the default `main` branch, not the Release source tree.

Before any self-hosted workflow is restored:
1. Merge and verify the workflow-removal change on `main`; until then, treat the workflows as active.
2. Apply branch protection and required checks to `main` and release branches.
3. Confirm the runner's actual OS account, groups, sudo rules, work directory, and persistence model from the host.
4. Verify that a repository write cannot turn a workflow file into arbitrary privileged shell execution.
5. Restore only a reviewed, allowlisted diagnostic workflow after the runner is isolated from production credentials and application data.

## Release gate

This is not closed by editing application code. A repository administrator must apply the branch rules and a host administrator must verify runner isolation and sudo boundaries. Attach evidence (settings screenshots or API output with sensitive values removed) to the release record.
