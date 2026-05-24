# GitHub security hardening handoff

這份 handoff 記錄本 PR 已能在 repo 內驗證的 CI / dependency gate，以及必須由 GitHub repository admin 在 UI 或 API 啟用的安全設定。

## 已在 repo 內落地

- `.github/workflows/ci.yml`
  - `pull_request`、`dev` / `main` push、`workflow_dispatch` 觸發。
  - Node `22.x` / `24.x` matrix。
  - `permissions: contents: read`，不使用 secrets、不部署、不使用 `pull_request_target`。
  - Blocking checks：`npm ci`、`npm audit --audit-level=moderate`、`npm run build:check`、`npm run lint`、`npm run format:check`、`npm test`。
- `.github/workflows/dependency-review.yml`
  - 只在 PR 與手動觸發執行。
  - `actions/dependency-review-action@v5`，`fail-on-severity: high`，`fail-on-scopes: runtime`。
- `.github/dependabot.yml`
  - 每週更新 npm dependencies 與 GitHub Actions。
  - npm minor / patch grouped，避免一次產生太多小 PR。
- `package.json` / `package-lock.json`
  - Node engine 對齊 `>=22.0.0`。
  - 已把 runtime / full `npm audit --audit-level=moderate` 清到 0 vulnerabilities。

## GitHub UI / API 必做檢查

這些設定無法只靠本機檔案證明，merge 後請由 repository admin 在 GitHub 啟用或確認。

### 1. Dependabot alerts 與 security updates

- 啟用 Dependency graph。
- 啟用 Dependabot alerts。
- 啟用 Dependabot security updates。
- 驗證 weekly version updates 會依 `.github/dependabot.yml` 產生 PR。

理由：Dependabot alerts 用來發現既有 vulnerable dependencies；dependency review 則是在 PR 階段阻擋新引入的 vulnerable dependencies。

參考：

- https://docs.github.com/en/code-security/concepts/supply-chain-security/about-dependabot-alerts
- https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- https://docs.github.com/en/code-security/concepts/supply-chain-security/about-dependency-review

### 2. Secret scanning 與 push protection

- 啟用 secret scanning。
- 啟用 push protection。
- 若 organization 有自訂 token / host pattern，補 custom patterns。
- 若目前 repo 歷史曾出現 credential alert，先 rotate affected credential，再處理歷史清理。

理由：CI workflow 本身不讀 secrets；但 repo 仍應在 commit / push 階段阻擋 hardcoded credentials。

參考：

- https://docs.github.com/en/code-security/concepts/secret-security/about-secret-scanning

### 3. CodeQL / code scanning

優先順序：

1. 若 GitHub UI 可用，先啟用 CodeQL default setup。
2. 若 default setup 不可用或需要自訂查詢，再另開 PR 加 `github/codeql-action` workflow。

理由：本 PR 先補最小 CI 與 supply-chain gate；CodeQL 是否用 default setup 取決於 repository / organization 的 GitHub Code Security 可用性，無法本機確認。

參考：

- https://docs.github.com/en/code-security/concepts/code-scanning/codeql/about-code-scanning-with-codeql

### 4. Branch protection / rulesets

對 `dev` 與 `main` 設定 branch protection 或 repository rulesets：

- Require pull request before merging。
- Require status checks to pass before merging。
- Required checks 第一波建議：
  - `CI / Node 22.x`
  - `CI / Node 24.x`
  - `Dependency Review`
- Require branches to be up to date before merging（若團隊接受 rebase / update branch 成本）。
- Block force pushes。
- Block deletions。
- 若有 release / deploy branch，再額外要求 CODEOWNERS 或 admin review。

理由：CI 與 dependency review 只有被 branch protection / rulesets 設為 required checks 時，才會成為 merge gate。若未來改用 self-hosted runner，需確認 runner 版本支援目前 action runtime。

參考：

- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

### 5. GitHub Actions 安全設定

- Repository Actions permissions 使用最小權限。
- 維持 workflow-level `permissions: contents: read`；若未來某 job 需要寫入，再只在該 job 提權。
- 限制 third-party actions 來源；若 organization policy 要求，改用 full-length commit SHA pinning。
- `.github/workflows/**` 變更建議要求 reviewer 或 CODEOWNERS。

理由：GitHub 建議讓 `GITHUB_TOKEN` 只有必要權限；third-party actions 若被 compromise，可能取得 repo token / secrets 權限。

參考：

- https://docs.github.com/en/actions/reference/security/secure-use

## 推薦 rollout 順序

1. Merge 本 PR，讓 CI、Dependency Review、Dependabot 設定先進 repo。
2. 在 GitHub 啟用 Dependabot alerts / security updates、secret scanning / push protection、CodeQL default setup。
3. 等第一輪 CI 與 dependency review 都在 PR 上跑過後，再把 `dev` / `main` 的 required checks 打開。
4. 若 `npm audit --audit-level=moderate` 未來因 transient advisory fail，先評估是否是 runtime 風險；不要直接移除 gate。必要時用 dependency update 或短期 override 解。
