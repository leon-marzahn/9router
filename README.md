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

## Data

Everything is stored locally in `~/.regent` (`%APPDATA%\regent` on Windows), or in `DATA_DIR` if set. Installs from before the rename are moved over from `~/.9router` automatically on first start.

## Development

The toolchain is [Vite+](https://viteplus.dev) (`vp`); see [`CLAUDE.md`](CLAUDE.md) for commands, tests and conventions, and [`docs/DESIGN.md`](docs/DESIGN.md) for the dashboard design system.

## Origins

Elizabeth's Proxy started as a fork of [9Router](https://github.com/decolua/9router) by decolua and contributors, and is now developed independently. It builds on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), [RTK](https://github.com/rtk-ai/rtk), [Caveman](https://github.com/JuliusBrussee/caveman) and [Ponytail](https://github.com/DietrichGebert/ponytail).

## License

MIT. See [LICENSE](LICENSE).
