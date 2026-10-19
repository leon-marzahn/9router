# REVIEW.md

How to review a PR in this repo. Written for a reviewer agent that did not write the change; CLAUDE.md covers how to build, this file covers how to check.

Assume nobody else will run the change in a browser. Do the hands-on checks yourself; don't infer them from the code or the author's report.

## Setup

```bash
git fetch origin <branch> && git checkout <branch>
bun install --frozen-lockfile        # always, before anything else
```
Use `bunx vp …` if `vp` isn't on PATH. Run your own instance per CLAUDE.md ("Working in a fresh worktree"): temp `DATA_DIR` **and** temp `HOME` (usage files ignore `DATA_DIR`), your own port, never 20127.

**Never push, commit to, or edit the PR.** You report; the author fixes.

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
