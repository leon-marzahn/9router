#!/usr/bin/env node
// List, or delete, the pinned backups in DATA_DIR/db/pinned-backups. They are the restore
// points for older versions and hold provider credentials in plaintext (an older version
// can't read encrypted ones), see src/lib/db/backup.js and docs/ARCHITECTURE.md.
//
//   vp run purge-plaintext-backups          list them and what each one restores
//   vp run purge-plaintext-backups --yes    delete them
//
// Deleting one removes the way back to the version it was taken for.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { defaultDataDir } = require("../src/lib/appDir.cjs");

// Label prefix → the versions that backup restores to.
const RESTORES = {
  "pre-usage-key-refs-":
    "v100.7.x, e.g. v100.7.2 (before usage rows stored key references, migration 005)",
  "pre-encrypt-credentials-":
    "v101.0.x, e.g. v101.0.2 (before credential encryption, migration 006), or this version from before a downgrade heal",
};
const describe = (name) =>
  Object.entries(RESTORES).find(([p]) => name.startsWith(p))?.[1] ?? "an older version";

const dataDir = process.env.DATA_DIR || defaultDataDir();
const pinned = path.join(dataDir, "db", "pinned-backups");
const dirs = fs.existsSync(pinned)
  ? fs
      .readdirSync(pinned, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];

if (!dirs.length) {
  console.log(`No plaintext restore points in ${pinned}.`);
  process.exit(0);
}
const yes = process.argv.includes("--yes");
console.log(`${yes ? "Deleting" : "These"} pinned backups hold provider credentials in plaintext:`);
for (const d of dirs)
  console.log(`  ${path.join(pinned, d)}\n    restore point for ${describe(d)}`);
if (!yes) {
  console.log(
    "Keep them until this version is known good. Delete them with: vp run purge-plaintext-backups --yes",
  );
  process.exit(0);
}
for (const d of dirs) fs.rmSync(path.join(pinned, d), { recursive: true, force: true });
console.log(`Deleted ${dirs.length} backup(s).`);
