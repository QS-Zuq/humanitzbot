# GitHub security hardening handoff

繁體中文：[`security-hardening.zh-TW.md`](./security-hardening.zh-TW.md)

This handoff records the CI and dependency gates that this PR can verify from repository files, plus the security settings that a GitHub repository admin must enable or confirm through the GitHub UI or API.

## Implemented in this repository

- `.github/workflows/ci.yml`
  - Runs on `pull_request`, pushes to `dev` / `main`, and `workflow_dispatch`.
  - Tests Node `22.x` / `24.x` in a matrix.
  - Uses `permissions: contents: read`; no secrets, no deployment, and no `pull_request_target`.
  - Blocking checks: `npm ci`, `npm audit --audit-level=moderate`, `npm run build:check`, `npm run lint`, `npm run format:check`, and `npm test`.
- `.github/workflows/dependency-review.yml`
  - Runs only on pull requests and manual dispatch.
  - Uses `actions/dependency-review-action@v5` with `fail-on-severity: high` and `fail-on-scopes: runtime`.
- `.github/dependabot.yml`
  - Runs weekly npm dependency updates and GitHub Actions updates.
  - Groups npm minor / patch updates to reduce PR noise.
- `package.json` / `package-lock.json`
  - Aligns the Node engine with `>=22.0.0`.
  - Runtime and full `npm audit --audit-level=moderate` are currently clean with 0 vulnerabilities.

## GitHub UI / API checks for repository admins

These settings cannot be proven by local repository files alone. After merge, a repository admin should enable or confirm them in GitHub.

### 1. Dependabot alerts and security updates

- Enable Dependency graph.
- Enable Dependabot alerts.
- Enable Dependabot security updates.
- Confirm weekly version updates create PRs according to `.github/dependabot.yml`.

Why: Dependabot alerts identify vulnerable dependencies that already exist in the dependency graph; dependency review blocks newly introduced vulnerable dependencies at PR time.

References:

- https://docs.github.com/en/code-security/concepts/supply-chain-security/about-dependabot-alerts
- https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- https://docs.github.com/en/code-security/concepts/supply-chain-security/about-dependency-review

### 2. Secret scanning and push protection

- Enable secret scanning.
- Enable push protection.
- Add custom patterns if the organization has custom tokens or host-specific secrets.
- If repository history already has credential alerts, rotate the affected credentials first, then decide whether history cleanup is still needed.

Why: The CI workflows do not read secrets, but the repository should still block hardcoded credentials before they are pushed.

Reference:

- https://docs.github.com/en/code-security/concepts/secret-security/about-secret-scanning

### 3. CodeQL / code scanning

Recommended order:

1. If available in the GitHub UI, enable CodeQL default setup first.
2. If default setup is unavailable or custom queries are required, add a `github/codeql-action` workflow in a follow-up PR.

Why: This PR establishes the minimum CI and supply-chain gates. Whether CodeQL default setup is available depends on repository and organization GitHub Code Security settings, which cannot be confirmed locally.

Reference:

- https://docs.github.com/en/code-security/concepts/code-scanning/codeql/about-code-scanning-with-codeql

### 4. Branch protection / rulesets

Configure branch protection or repository rulesets for `dev` and `main`:

- Require pull request before merging.
- Require status checks to pass before merging.
- First-wave required checks:
  - `CI / Node 22.x`
  - `CI / Node 24.x`
  - `Dependency Review`
- Require branches to be up to date before merging, if the team accepts the rebase / update-branch cost.
- Block force pushes.
- Block deletions.
- If there are release or deploy branches, additionally require CODEOWNERS or admin review.

Why: CI and dependency review become merge gates only after branch protection or rulesets require their checks to pass. If the project later uses self-hosted runners, confirm the runner version supports the current action runtimes.

Reference:

- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

### 5. GitHub Actions security settings

- Keep repository Actions permissions least-privileged.
- Keep workflow-level `permissions: contents: read`; if a future job needs write access, elevate only that job.
- Restrict third-party action sources; if organization policy requires it, pin actions by full-length commit SHA.
- Require reviewer approval or CODEOWNERS review for `.github/workflows/**` changes.

Why: GitHub recommends granting `GITHUB_TOKEN` only the permissions required. A compromised third-party action can otherwise gain access to repository tokens or secrets.

Reference:

- https://docs.github.com/en/actions/reference/security/secure-use

## Recommended rollout order

1. Merge this PR so CI, Dependency Review, and Dependabot configuration are present in the repository.
2. Enable Dependabot alerts / security updates, secret scanning / push protection, and CodeQL default setup in GitHub.
3. After the first CI and dependency review checks have run on PRs, make the `dev` / `main` checks required.
4. If `npm audit --audit-level=moderate` fails in the future because of a transient advisory, first assess whether it affects runtime risk. Do not remove the gate silently; prefer dependency updates or a narrow temporary override.
