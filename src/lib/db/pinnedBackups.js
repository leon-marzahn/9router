// Names and metadata of the pinned backups (db/pinned-backups): the plaintext restore points
// for older versions. Dependency-free so scripts/purge-plaintext-backups.mjs can import it
// with plain Node (no `@/` alias).
//
// One backup is taken per boot, before every one-way migration that boot runs, and named
//   pre-<migration>[+<migration>...]-schema<N>-<timestamp>
// e.g. pre-usage-key-refs+encrypt-credentials-schema4-20261020-101500 for a v100 → v102
// upgrade. N is the schema of the DB inside, which decides the release it restores to. A
// backup.json next to data.sqlite records the same facts. Backups taken before this
// naming (`<label>-<app version>-<timestamp>`) are still recognised.
import fs from "node:fs";
import path from "node:path";

export const PRE_USAGE_KEY_REFS = "pre-usage-key-refs";
export const PRE_ENCRYPT_CREDENTIALS = "pre-encrypt-credentials";
export const PINNED_BACKUP_LABELS = [PRE_USAGE_KEY_REFS, PRE_ENCRYPT_CREDENTIALS];
export const BACKUP_META_FILE = "backup.json";

// Schema the DB had when an old-style backup of each label was taken by a straight upgrade.
const LEGACY_SCHEMA = { [PRE_USAGE_KEY_REFS]: 4, [PRE_ENCRYPT_CREDENTIALS]: 5 };

/** The release line a DB of `schemaVersion` restores to. */
export function releaseLineFor(schemaVersion) {
  if (schemaVersion === 4) return "v100.7.x (e.g. v100.7.2)";
  if (schemaVersion === 5) return "v101.0.x (e.g. v101.0.2)";
  if (schemaVersion >= 6)
    return `v101.0.x after a downgrade (schema ${schemaVersion} with the plaintext credentials the older version wrote)`;
  return `an older version (schema ${schemaVersion ?? "unknown"})`;
}

/** Directory name for a backup taken before `labels` (["pre-a", "pre-b"]) at `schemaVersion`. */
export function backupName(labels, schemaVersion, timestamp) {
  const list = [].concat(labels);
  const joined = [list[0], ...list.slice(1).map((l) => l.replace(/^pre-/, ""))].join("+");
  return `${joined}-schema${schemaVersion}-${timestamp}`;
}

/**
 * Parses a backup directory name, new or old style: { labels, schemaVersion } (schema
 * inferred for old-style pinned names), or null when it is neither.
 */
export function parseBackupName(name) {
  const m = /^(pre-[a-z0-9-]+?(?:\+[a-z0-9-]+?)*)-schema(\d+)-/.exec(name);
  if (m) {
    const [first, ...rest] = m[1].split("+");
    return { labels: [first, ...rest.map((l) => `pre-${l}`)], schemaVersion: Number(m[2]) };
  }
  const legacy = PINNED_BACKUP_LABELS.find((l) => name.startsWith(`${l}-`));
  if (legacy) return { labels: [legacy], schemaVersion: LEGACY_SCHEMA[legacy], legacy: true };
  return null;
}

/** True for a backup that must never be pruned or sealed. */
export function isPinnedName(name) {
  const parsed = parseBackupName(name);
  return !!parsed && parsed.labels.some((l) => PINNED_BACKUP_LABELS.includes(l));
}

/** The backup.json written next to a backup's data.sqlite. */
export function backupMeta({ labels, schemaVersion, appVersion }) {
  return {
    schemaVersion,
    createdBy: appVersion,
    precedes: [].concat(labels),
    restoresTo: releaseLineFor(schemaVersion),
  };
}

/**
 * What a backup directory holds: backup.json when present, else what its name says.
 * { schemaVersion, createdBy, precedes, restoresTo }.
 */
export function describeBackup(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, BACKUP_META_FILE), "utf8"));
    if (meta && Array.isArray(meta.precedes)) {
      return { ...meta, restoresTo: meta.restoresTo || releaseLineFor(meta.schemaVersion) };
    }
  } catch {}
  const parsed = parseBackupName(path.basename(dir));
  if (!parsed)
    return { schemaVersion: null, createdBy: null, precedes: [], restoresTo: releaseLineFor(null) };
  const oldVer = parsed.legacy
    ? /^pre-[a-z-]+?-(\d+\.\d+\.\d+)-/.exec(path.basename(dir))?.[1]
    : null;
  let restoresTo = releaseLineFor(parsed.schemaVersion);
  // An old-style pre-encrypt-credentials may also come from a heal after a downgrade.
  if (parsed.legacy && parsed.labels[0] === PRE_ENCRYPT_CREDENTIALS)
    restoresTo += ", or v101.0.x after a downgrade if a heal took it";
  return {
    schemaVersion: parsed.schemaVersion,
    createdBy: oldVer ?? null,
    precedes: parsed.labels,
    restoresTo,
  };
}
