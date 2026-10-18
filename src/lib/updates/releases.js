// Latest-release lookup on GitHub, cached in memory. Fails silent: offline or
// rate-limited just means "no update known".
import pkg from "../../../package.json" with { type: "json" };
import { pickUpdate } from "./version.js";

export const RELEASES_REPO = "leon-marzahn/regent";
const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`;
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;
const TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

const g = (globalThis.__regentReleases ??= { at: 0, ttl: 0, releases: null, pending: null });

export function currentVersion() {
  return pkg.version;
}

/** REGENT_UPDATE_CHECK=false (or 0/off/no) turns every outbound check off. */
export function updateCheckEnabled(env = process.env) {
  const v = String(env.REGENT_UPDATE_CHECK ?? "")
    .trim()
    .toLowerCase();
  return !["false", "0", "off", "no"].includes(v);
}

async function fetchReleases(fetchImpl) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `regent/${currentVersion()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("Unexpected GitHub response");
  return list
    .filter((r) => r && !r.draft && typeof r.tag_name === "string")
    .map((r) => ({
      tag: r.tag_name,
      url: typeof r.html_url === "string" ? r.html_url : RELEASES_PAGE,
    }));
}

/** Published releases (cached ~24h; null when unknown). */
export async function getReleases({ force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!updateCheckEnabled()) return null;
  if (!force && now - g.at < g.ttl) return g.releases;
  g.pending ??= fetchReleases(fetchImpl)
    .then((r) => Object.assign(g, { releases: r, at: Date.now(), ttl: TTL_MS }))
    .catch(() => Object.assign(g, { at: Date.now(), ttl: FAIL_TTL_MS }))
    .finally(() => (g.pending = null));
  await g.pending;
  return g.releases;
}

export function _resetReleaseCache() {
  Object.assign(g, { at: 0, ttl: 0, releases: null, pending: null });
}

/** Newest release for `current` on `channel`, with its notes URL. */
export function findUpdate(releases, current, channel = "any") {
  if (!releases?.length) return null;
  const version = pickUpdate(
    current,
    releases.map((r) => r.tag),
    { channel },
  );
  if (!version) return null;
  const rel = releases.find((r) => r.tag.replace(/^v/, "") === version);
  return { version, url: rel?.url || RELEASES_PAGE };
}
