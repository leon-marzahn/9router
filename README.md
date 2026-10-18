<div align="center">
  <img src="./public/icons/icon-192.svg" alt="" width="72" height="72"/>

  # Elizabeth's Proxy

  A local AI routing gateway with a live dashboard. One OpenAI-compatible endpoint in front of 40+ providers and all your accounts.
</div>

---

Point Claude Code, Codex, Cursor, Cline, OpenCode or any OpenAI-compatible client at `http://localhost:20128/v1`. Elizabeth's Proxy picks a provider and account for every request, translates between API formats, falls back when one fails, and shows you what's healthy in real time.

- **Multi-provider, multi-account routing** with combos and automatic fallback (subscription → cheap → free).
- **Format translation** between OpenAI, Anthropic, Gemini, Responses and provider-specific APIs.
- **OAuth and API-key accounts** with token refresh, quota tracking and per-model cooldowns.
- **Token saver** that compresses tool output before it reaches the model.
- **Live dashboard** ("warm workbench" design): health first, problems pinned to the top, everything updates without reloading.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev                      # dashboard on http://localhost:20127/dashboard
```

Production:

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
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

## Origins

Elizabeth's Proxy started as a fork of [9Router](https://github.com/decolua/9router) by decolua and contributors, and is now developed independently. It builds on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), [RTK](https://github.com/rtk-ai/rtk), [Caveman](https://github.com/JuliusBrussee/caveman) and [Ponytail](https://github.com/DietrichGebert/ponytail).

## License

MIT. See [LICENSE](LICENSE).
