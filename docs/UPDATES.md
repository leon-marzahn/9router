# Updates

## Update notice

The dashboard checks GitHub for a newer release about once a day and shows a quiet "vX available" line in the account menu and in **Settings → About**. Only the version list is fetched; nothing about your install is sent. Set `REGENT_UPDATE_CHECK=false` to turn the check (and the redeploy hook below) off.

## Docker image tags

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

## Redeploy webhook

If your platform redeploys from a webhook (Coolify, Portainer, CapRover, Dokploy…), paste its deploy-hook URL in **Settings → Updates**. When the daily check finds a newer release on the channel you follow ("same major" or "any newer"), the dashboard sends one `POST` to the hook with a small JSON body (`{"event":"regent.update","version":"…","current":"…"}`), then shows the result. It calls the hook at most once per version and never for a version older than or equal to the one running. "Send test" calls it with `"event":"regent.test"`.

### Example: Coolify

1. Open the application → **Webhooks** and copy the deploy webhook (`https://<coolify>/api/v1/deploy?uuid=…&force=false`).
2. Create an API token with deploy permission under **Keys & Tokens**.
3. Paste both into **Settings → Updates**. The token goes in the optional token field and is sent as `Authorization: Bearer …`.
4. Deploy the image with a floating tag such as `:100`, so the redeploy pulls the new release.

### Rules for the hook

- The hook URL and token are stored as secrets: they're never shown in the dashboard again, never returned by the API (only its host), and left out of backups.
- It must be `https`. Plain `http` is accepted only for local network addresses (private IPs, `localhost`, `*.local`, `*.lan`, `*.internal`, single-label hostnames).
- Redirects are not followed.

## CLI and tray

The `regent` CLI launcher and tray don't update themselves yet; reinstall the new version by hand.
