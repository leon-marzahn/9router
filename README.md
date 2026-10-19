<div align="center">
  <img src="./public/icons/icon-192.svg" alt="" width="72" height="72"/>

  # Elizabeth's Proxy

  A self-hosted AI routing gateway with a live dashboard. One OpenAI-compatible endpoint in front of 40+ providers and all your accounts.

  <sub>The command, package, data folder and Docker image are called <code>regent</code>.</sub>
</div>

---

Point Claude Code, Codex, Cursor, Cline, OpenCode or any OpenAI-compatible client at `http://localhost:20128/v1`. Elizabeth's Proxy picks a provider and account for every request, translates between API formats, falls back when one fails, and shows you what's healthy in real time.

- **Multi-provider, multi-account routing** with combos and automatic fallback (subscription → cheap → free).
- **Format translation** between OpenAI, Anthropic, Gemini, Responses and provider-specific APIs.
- **OAuth and API-key accounts** with token refresh, quota tracking and per-model cooldowns.
- **Token saver** that compresses tool output before it reaches the model.
- **Live dashboard** ("warm workbench" design): health first, problems pinned to the top, everything updates without reloading.

## Quick start

Needs Node (version in `.node-version`) to run and [Bun](https://bun.sh) 1.3+ to install dependencies.

```bash
cp .env.example .env
bun install
bun run dev                      # dashboard on http://localhost:20127/dashboard
```

Production:

```bash
bun run build
PORT=20128 HOSTNAME=0.0.0.0 bun run start
```

Change `INITIAL_PASSWORD` and `JWT_SECRET` in `.env` before exposing the server to a network. The full environment reference is in `.env.example` and `docs/ARCHITECTURE.md`.

The CLI launcher (tray icon, auto-start, `regent connect` / `regent show` for configuring local tools) lives in [`cli/`](cli/). It isn't published to npm yet.

## Updating

The dashboard checks GitHub for a newer release about once a day and shows a quiet "vX available" line in the account menu and in **Settings → About**. Only the version list is fetched; nothing about your install is sent. Set `REGENT_UPDATE_CHECK=false` to turn the check (and the redeploy hook below) off.

### Docker image tags

Images are published to `ghcr.io/leon-marzahn/regent` (amd64 + arm64). Versions use [epoch semver](https://antfu.me/posts/epoch-semver), so the major is a number like `100`.

| Tag | Tracks |
| --- | --- |
| `100.2.3` | exactly that release, never moves |
| `100.2` | the newest patch of 100.2 |
| `100` | the newest release within major 100: new features, no breaking changes (recommended) |
| `latest` | the newest stable release, including new majors that may need manual steps |

Prereleases (`100.3.0-rc.1`) get only their own tag.

To update automatically, pin a floating tag (`:100`) and let a watcher pull it:

- [Watchtower](https://containrrr.dev/watchtower/) pulls and restarts the container when the tag moves.
- [Diun](https://crazymax.dev/diun/) only notifies you, if you'd rather update by hand.

### Redeploy webhook

If your platform redeploys from a webhook (Coolify, Portainer, CapRover, Dokploy…), paste its deploy-hook URL in **Settings → Updates**. When the daily check finds a newer release on the channel you follow ("same major" or "any newer"), the dashboard sends one `POST` to the hook with a small JSON body (`{"event":"regent.update","version":"…","current":"…"}`), then shows the result. It calls the hook at most once per version and never for a version older than or equal to the one running. "Send test" calls it with `"event":"regent.test"`.

Example with Coolify: open the application → **Webhooks** and copy the deploy webhook (`https://<coolify>/api/v1/deploy?uuid=…&force=false`), create an API token with deploy permission under **Keys & Tokens**, and paste both into **Settings → Updates** (the token goes in the optional token field and is sent as `Authorization: Bearer …`). Deploy the image with a floating tag such as `:100`, so the redeploy pulls the new release.

The hook URL and token are stored as secrets: they're never shown in the dashboard again, never returned by the API (only its host), and left out of backups. It must be `https`; plain `http` is accepted only for local network addresses (private IPs, `localhost`, `*.local`, `*.lan`, `*.internal`, single-label hostnames). Redirects are not followed.

### CLI and tray

The `regent` CLI launcher and tray don't update themselves yet; reinstall the new version by hand.

## Data

Everything is stored locally in `~/.regent` (`%APPDATA%\regent` on Windows), or in `DATA_DIR` if set. Installs from before the rename are moved over from `~/.9router` automatically on first start.

## Development

The toolchain is [Vite+](https://viteplus.dev) (`vp`); see [`CLAUDE.md`](CLAUDE.md) for commands, tests and conventions, and [`docs/DESIGN.md`](docs/DESIGN.md) for the dashboard design system.

## Compared to similar projects

All four route coding tools through one endpoint; they differ in scope and in who they're built for. Facts below come from each project's README (October 2026).

| | Elizabeth's Proxy | [9Router](https://github.com/decolua/9router) | [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | [LiteLLM](https://github.com/BerriAI/litellm) |
| --- | --- | --- | --- | --- | --- |
| Relationship | fork of 9Router | the original (JS port inspired by CLIProxyAPI) | fork of 9Router, TypeScript port | Go project 9Router was inspired by | independent |
| Stack | Next.js, JS + TS | Node.js | Next.js, TypeScript | Go | Python |
| Providers | 40+ | 40+ | 375 | built-in list + OpenAI-compatible | 100+ |
| Subscription logins (Claude Code, Codex…) | yes | yes | yes | yes | no |
| Fallback combos | yes | yes | yes, 20 strategies + auto-combo | no, account round-robin | retries/fallbacks across deployments |
| Dashboard | yes | yes | yes | no (management API, third-party UIs) | admin UI |
| Token compression | RTK, Caveman | RTK, Caveman | 12-engine pipeline | no | no |
| MCP / A2A gateway | no | no | yes | no | yes |
| Storage | SQLite | SQLite | SQLite | config files | Postgres + Redis |
| Distribution | Docker (GHCR) | npm, Docker | npm, Docker, Electron, PWA | Go binary, desktop clients | pip, Docker |

When to pick which:

- **9Router**: the upstream, with cloud sync across devices and an npm install.
- **OmniRoute**: the most features in one box (hundreds of providers, routing strategies, memory, MCP/A2A, desktop app).
- **CLIProxyAPI**: a lean headless proxy for CLI subscriptions, with a large ecosystem of third-party clients.
- **LiteLLM**: an API-key gateway for teams and apps, with virtual keys, spend tracking and guardrails.
- **Elizabeth's Proxy**: 9Router's routing with fewer moving parts and a dashboard redesigned around live health, plus request pipelines, per-conversation account affinity for prompt-cache reuse, and Docker images with floating epoch-semver tags and an optional redeploy webhook.

## Origins

Elizabeth's Proxy started as a fork of [9Router](https://github.com/decolua/9router) by decolua and contributors, and is now developed independently. It builds on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), [RTK](https://github.com/rtk-ai/rtk), [Caveman](https://github.com/JuliusBrussee/caveman) and [Ponytail](https://github.com/DietrichGebert/ponytail).

## License

MIT. See [LICENSE](LICENSE).
