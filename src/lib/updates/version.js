// Semver helpers for the update check. Epoch semver is still plain semver, so
// nothing here is regent-specific beyond "major" meaning e.g. 100.

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input) {
  const m = SEMVER.exec(String(input ?? "").trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
    raw: `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ""}`,
  };
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // release > prerelease
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);
    if (na && nb) {
      const d = Number(a[i]) - Number(b[i]);
      if (d) return Math.sign(d);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** -1 / 0 / 1; unparsable versions sort lowest. */
export function compareVersions(a, b) {
  const pa = typeof a === "string" ? parseVersion(a) : a;
  const pb = typeof b === "string" ? parseVersion(b) : b;
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  return comparePre(pa.prerelease, pb.prerelease);
}

export const CHANNELS = ["major", "any"];

/**
 * Whether `candidate` is an update for `current`.
 * - only strictly newer counts;
 * - prereleases only when the running version is itself a prerelease;
 * - channel "major" keeps to the running major (100.x), "any" takes anything newer.
 */
export function isEligibleUpdate(current, candidate, { channel = "any" } = {}) {
  const cur = parseVersion(current);
  const cand = parseVersion(candidate);
  if (!cur || !cand) return false;
  if (cand.prerelease.length && !cur.prerelease.length) return false;
  if (channel === "major" && cand.major !== cur.major) return false;
  return compareVersions(cand, cur) > 0;
}

/** Highest eligible version from a list of tag names, or null. */
export function pickUpdate(current, tags, opts) {
  let best = null;
  for (const t of tags || []) {
    if (!isEligibleUpdate(current, t, opts)) continue;
    if (!best || compareVersions(t, best) > 0) best = t;
  }
  return best ? parseVersion(best).raw : null;
}
