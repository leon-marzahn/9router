# REVIEW.md

How to review a PR in this repo. Written for a reviewer agent that did not write the change; CLAUDE.md covers how to build, this file covers how to check.

Review happens on the pushed branch **before** the PR is opened, and every change gets one. Assume nobody else will run it: do the hands-on checks yourself rather than inferring them from the code or the author's report. Changes to the request path, pricing/billing, budgets or auth always get hands-on requests against a fake OpenAI-compatible upstream.

## Setup

```bash
git fetch origin <branch> && git checkout <branch>
bun install --frozen-lockfile        # always, before anything else
```
Use `bunx vp …` if `vp` isn't on PATH. Run your own instance on a free port with a throwaway data dir (all state, usage included, follows `DATA_DIR`); never `bun run dev`, which binds 20127 (likely a developer's own server) and reads the real `~/.regent`:
```bash
DATA_DIR="$(mktemp -d)" PORT=20137 NEXT_PUBLIC_BASE_URL=http://localhost:20137 bunx next dev --webpack --port 20137
```
Log in with the default password `123456`; seed what you need through the dashboard or API (`scripts/pr-shots/seed.mjs` shows how). Stop the server when done.

**Never push to or edit the branch or PR.** You report; the author fixes.

## Order of review

### 1. Security (always first)
- **Auth:** every new/changed route is behind the dashboard guard, or deliberately public with a comment and an entry in the auth-gate test allow-list. API keys must not open dashboard routes; dashboard sessions must not stand in for API keys where a key is required.
- **Secrets:** no key, token, cookie, password, `Authorization` header or proxy `user:pass` in GET responses, logs, error bodies, traces, screenshots, backups (unless intended) or the URL. Write-only secrets report only "configured".
- **Isolation (reseller):** one API key never sees another key's data. Customer-facing responses expose no provider, account, upstream URL, internal ids or raw cost.
- **Input:** validation on every body/query field; CR/LF rejected where it ends up in headers or email.
- **SSRF:** user-supplied URLs/hosts go through `src/shared/utils/ssrfGuard.js`; no redirects followed to private targets.
- **Client IP:** rate limits and IP checks use `getClientIp` (custom-server.js trust rules), never raw `X-Forwarded-For`.
- **Fail-open vs fail-closed:** helpers on the request path (RTK, tracing, notifications) must never break a request; access controls (budgets with a hard stop, auth) must not silently open.

### 2. Does it work (hands-on)
- Exercise the changed flows in your instance, with a fake OpenAI-compatible upstream when traffic is needed. Seed what you need.
- UI: every changed page/state at desktop 1440 and mobile 375 (touch emulation; `scripts/pr-shots.mjs` has it), light and dark. Check:
  - no horizontal overflow: `document.scrollWidth === document.documentElement.clientWidth`, nothing past the right edge
  - no console errors, no unexpected 4xx/5xx
  - tap targets ≥ 40px on mobile; text fields 16px (no iOS zoom)
  - nothing that only works on hover; hover-only hints hidden on touch
  - empty, loading and error states; long names/URLs truncate or wrap
  - dialogs open as bottom sheets on mobile with reachable actions
- **Open the PR's screenshots yourself** and compare against what you saw. Stray hover highlights, clipped text and cut-off controls count as findings.
- Backend: the behaviour claimed in the PR body actually happens (status codes, stored rows, emails in the catcher, etc.).

### 3. Design system
- Built from `src/ui` components and tokens (docs/DESIGN.md): no legacy `@/shared/components` in new UI, no raw `<button>/<input>/<select>` in pages, no hard-coded colors.
- Matches the existing patterns: workbench list/detail with `?view=overview` on mobile, secondary "New" + `ListAddRow` for creating, Dialog/ConfirmDialog.

### 4. Tests and CI
- Typecheck, `vp lint` on changed files, and `vp test run` pass on the branch.
- The same gates CI runs, locally:
  ```bash
  bun run typecheck
  scripts/ci/lint-changed.sh origin/master   # Oxlint on changed files, incl. no legacy @/shared/components in new UI
  bun run lint:design                        # raw controls / raw colors; baseline in scripts/ci/design-lint-baseline.txt
  bun run coverage                           # then:
  node scripts/ci/diff-coverage.mjs origin/master   # ≥ 80% of changed executable lines covered (waived only by the coverage-exempt label)
  node scripts/ci/coverage-ratchet.mjs check # overall coverage not below tests/__baseline__/coverage.json (`update` raises it)
  bun run smoke                              # browser smoke of every route and UI state: overflow, console/HTTP errors, mobile tap targets, axe
  bun run smoke --changed origin/master      # only what the branch can affect, as CI does on PRs
  ```
- New `bun run smoke` findings get fixed, not added to `scripts/ui-smoke/baseline.txt`, unless the PR explains why.
- A PR that adds a dialog, drawer, sheet or menu adds its state to `scripts/ui-smoke/states.json` (same format as pr-shots `--shots`: `name`, `route`, `steps`, `selector` on the dialog), so the smoke opens it at desktop and mobile. Check `bun run smoke --states <name>` passes. A changed one keeps its state working.
- Baselines (`known-fails.txt`, `design-lint-baseline.txt`, `coverage.json`) may only move in the good direction: fewer known fails and violations, higher coverage.
- New behaviour has tests that would fail without the change (spot-check by reverting a line). Security properties get explicit tests.
- No new entries in `tests/__baseline__/known-fails.txt` (or any other baseline) without a reason in the PR.
- Migrations: numbered after master's latest, apply on an empty DB and on an existing one; the PR's Merge Danger says it's hard to undo.

### 5. The PR itself
- Summary / Evidence / Merge Danger present (see the `pr` skill), security note present, no attribution lines, Conventional Commit title.
- Evidence shows the actual state that changed (dialog open, error shown), demo data only (the repo is public).

## Report format

```
Verdict: approve | needs changes

Findings (most severe first):
1. [security|bug|ui|design|tests] file:line — what's wrong
   Repro: steps / request / viewport
   Fix: suggestion

Verified hands-on: …
Only read, not run: …
```
Say plainly what you did not check. A short "approve" with a clear list of what you ran beats a long review of code you only read.
