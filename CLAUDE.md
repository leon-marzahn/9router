# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Elizabeth's Proxy (internal/machine name `regent`; package `regent-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `regent-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, package/command `regent`, not published to npm yet) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
bun install                                                          # or `vp install` (picks bun)
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 bun run dev   # dev (webpack, port 20127 by default via next dev)
bun run build && PORT=20128 HOSTNAME=0.0.0.0 bun run start           # production
```
- **Package manager is Bun** (`packageManager` in `package.json`, lockfile `bun.lock`), for installs only: `bun run <script>` still executes Next/tsc/vitest on Node. The `dev:bun` / `build:bun` / `start:bun` scripts are the separate, optional Bun *runtime* variants.
- Install scripts run only for `trustedDependencies` in `package.json` (currently just `better-sqlite3`). Add a package there only if it can't work without its script, and say why in the PR.
- After an upstream 9router sync (upstream is on npm), don't merge their `package-lock.json`: take the merged `package.json`, run `bun install`, and commit the regenerated `bun.lock`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Toolchain is **Vite+** (`vp`, global install; it manages Node — pinned in `.node-version`). Config lives in `vite.config.ts` (`test`, `lint`, `fmt` blocks). Next.js still owns dev/build (`bun run dev` / `bun run build`), not `vp dev`/`vp build`.
- `vp check` = format + lint (Oxlint, type-aware via tsgolint) + type-check. ~150 pre-existing React Compiler lint errors in upstream pages make it exit non-zero; judge your change by not adding new ones (`vp lint <paths>`).
- Formatting (`vp fmt`) is scoped by an allow-list in `vite.config.ts` `fmt.ignorePatterns` to fork-owned files only, so upstream files keep their style and merges stay clean. Add new fork-owned files/dirs there.

### Working in a fresh worktree (agents)
**The tools are installed — don't conclude otherwise.** Bun is at `~/.bun/bin`; Vite+ is at `~/.local/share/vite-plus/bin/vp` (the user's shell defines `vp` as a function, so a non-interactive shell may say `vp: command not found`). The `SessionStart` hook (`.claude/hooks/ensure-deps.sh`) adds both to `PATH` and installs `node_modules` in a fresh worktree. Subagents and worktrees created by tools may not run that hook, so **run `bun install --frozen-lockfile` once before your first typecheck/lint/test** (a ~1s no-op when already complete; it fixes a missing or half-installed `node_modules`). If a command is still missing:
- `vp …` → `~/.local/share/vite-plus/bin/vp …`, or `bunx vp …`, or the `bun run` script (`bun run test`, `bun run lint`, `bun run typecheck`).
- no `node_modules` → `bun install --frozen-lockfile`.
- Chromium for screenshots → `bunx playwright@1.63.0 install chromium`.
Never skip a check or tell the user a tool "isn't installed" before trying these.

**Try every UI change in a running dev server before opening the PR.** Typecheck and tests don't catch a broken page. Start your own instance (never `bun run dev`: it binds port 20127, likely the user's own server, and reads the real `~/.regent` data):
```bash
DATA_DIR="$(mktemp -d)" PORT=20137 NEXT_PUBLIC_BASE_URL=http://localhost:20137 bunx next dev --webpack --port 20137
```
Run it in the background, pick another port if 20137 is taken, open the changed pages in the browser tool (log in with the default password `123456`), click through the flows you touched at desktop and 375px width, and check the console for errors. The scratch data starts empty (no providers), so seed what the check needs through the dashboard or API; `scripts/pr-shots/seed.mjs` shows how to seed demo data. Usage/log files ignore `DATA_DIR` and still go to `~/.regent` (see Persistence), so don't send real model traffic. Stop the server when done.

### PR evidence (agents)
CI (`.github/workflows/pr.yml`) runs typecheck, `vp lint` on the files the PR changes (`scripts/ci/lint-changed.sh`; fix errors in files you touch), and `vp test run`, which must be green: any failure fails the job unless it is listed in `tests/__baseline__/known-fails.txt` (empty; `scripts/ci/compare-tests.mjs` also reports listed tests that pass again). For UI changes, attach screenshots of demo data only (the repo is public):
```bash
node scripts/pr-shots.mjs --routes /dashboard/usage,/dashboard/providers --label after [--dark]
node scripts/pr-shots.mjs --shots shots.json --label after   # specific states: opened dialogs, filled forms, menus
node scripts/pr-shots-publish.mjs --pr <number>
```
The first boots its own seeded instance (temp `DATA_DIR` + `HOME`, random password) and writes PNGs (1440×900 and 375×812) to `pr-shots/`; for before/after, also run it on the base branch with `--label before`. The second pushes them to the orphan `pr-assets` branch under `pr-<number>/` and prints Markdown links for the PR's Evidence section. When the change is a state rather than a page (a new dialog, menu, validation error), the shot must show that state: describe it in a `--shots` JSON file (`name`, `route`, `steps` of `click`/`fill`/`hover`/`press`/`waitFor`/`wait`, optional `selector` to crop to the dialog); the format is documented at the top of `scripts/pr-shots.mjs`. Copy `scripts/pr-shots/example-shots.json` as a starting point. Needs Chromium for playwright-core 1.63 (`bunx playwright@1.63.0 install chromium` if not preinstalled).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (Vitest 5 via Vite+, files in `tests/`; config is the `test` block of the root `vite.config.ts`):
```bash
bun install                             # root deps (tests import from src/ and open-sse/)
vp test                                 # all tests, run from the repo root
vp test run tests/unit/capabilities.test.js   # single file
```
> Test runs are isolated from your real data: `vite.config.ts` points `DATA_DIR`, `HOME`, `USERPROFILE` and `APPDATA` at a fresh temp dir per run, so nothing reaches `~/.regent`.
> `tests/package.json` only exists for `"type": "module"`; it has no deps of its own. Tests run with the repo root as cwd — resolve file paths with `import.meta.dirname`, not `path.resolve("../…")`.
>
> **The suite is expected to be all-green on a plain checkout** (~3920 pass, ~95 skipped, 0 fail). `tests/__baseline__/known-fails.txt` lists tests that are allowed to fail (one `file :: full name` per line); it is empty — keep it that way, and if a red test truly can't be fixed in your change, add it there with a reason in the PR. (`tests/__baseline__/verify-no-regression.mjs` assumes Docker `/app/` paths and misreports locally.) Skipped on purpose:
> - `real/*.real.test.js` and `unit/*.live.test.js` make live provider calls — they skip unless `RUN_REAL=1` (plus credentials) is set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.regent/`; the default comes from `src/lib/appDir.cjs`, which moves a pre-rename `~/.9router` over once).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.regent` and do **not** follow `DATA_DIR`.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- **Naming.** Display name is "Elizabeth's Proxy"; machine names (data dir, CLI command, package, headers, keys written into tool configs, User-Agents) use `regent`. This fork split from upstream 9Router: legacy `9router` names are still *read* (data-dir migration, `X-9Router-*` headers, `9router` provider keys in tool configs, autostart entries) but never written. Intentionally unchanged: the MITM root CA name and password salt (renaming breaks trusted certs/stored secrets), the SAML issuer default `urn:9router:sp`, and `NINE_ROUTER_*` env vars.

- JavaScript (ESM) everywhere except the redesigned UI: **new UI code is TypeScript** in `src/ui/` (design system + app frame) following `docs/DESIGN.md`. Backend, `open-sse/`, and not-yet-migrated pages stay JS. `@/*` → `src/*` (`tsconfig.json`, `allowJs`). TypeScript is **7 (tsgo)**, plain `typescript@7` (no bridge needed since ESLint was replaced by Oxlint). Typecheck with `bun run typecheck`; `next build` also type-checks, including Next's route-export rules (route files may only export handlers/config).
- UI redesign: the fork is rewriting the dashboard UI (diverges from upstream UI on purpose). Build pages from `src/ui` components and tokens; don't hard-code colors.
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- **Security-first on PRs**: Security is the top priority when reviewing or creating PRs. Audit authentication, credential/token storage & leaks, header manipulation (`X-Forwarded-For`), and SSRF risks before functional logic. Always include explicit security warnings/notes when reporting PR reviews or changes to the user.
- Versioning: [epoch semver](https://antfu.me/posts/epoch-semver), `{epoch*100+major}.minor.patch`, starting at 100.0.0. Root and `cli/` share a version (the Docker workflow checks both against the `vX.Y.Z` tag). An upstream sync is a minor bump (major if it breaks things); update `forkedFrom` in `package.json` (9router version + commit) when syncing. Fetch `decolua` with `--no-tags` so upstream `v0.5.x` tags don't mix with ours. Changes are logged in `CHANGELOG.md`. Release with `vp run release <x.y.z>` (bumps root + cli, prepends the git-cliff entry from `cliff.toml`, commits and tags), then `git push && git push origin v<x.y.z>` — push the tag on its own: pushed together with the branch via `--follow-tags`, GitHub didn't start the tag workflows. The tag builds the Docker image and changelogithub writes the GitHub release notes. Name upstream sync merges `chore(sync): 9router <version>`. Do not title other commits `chore(release)`: the changelog tools skip that prefix (use `ci(release)`). Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).
