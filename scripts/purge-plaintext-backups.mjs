#!/usr/bin/env node
// List, or delete, the pinned backups in DATA_DIR/db/pinned-backups. They are the restore
// points for older versions and hold provider credentials in plaintext (an older version
// can't read encrypted ones), see src/lib/db/backup.js and docs/ARCHITECTURE.md.
//
// One backup per upgrade: a v100 → v102 upgrade takes a single
// pre-usage-key-refs+encrypt-credentials-schema4-* (schema 4 = v100.7.x). Its backup.json
// says what it restores; older names (pre-<step>-<app version>-*) are read from the name.
//
//   vp run purge-plaintext-backups          list them and what each one restores
//   vp run purge-plaintext-backups --yes    delete them
//
// Deleting one removes the way back to the version it was taken for.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describeBackup } from "../src/lib/db/pinnedBackups.js";

const require = createRequire(import.meta.url);
const { defaultDataDir } = require("../src/lib/appDir.cjs");

const STEP_NAMES = {
  "pre-usage-key-refs": "usage key references (migration 005)",
  "pre-encrypt-credentials": "credential encryption (migration 006)",
};
const describe = (dir) => {
  const m = describeBackup(dir);
  const steps = m.precedes.map((l) => STEP_NAMES[l] ?? l).join(" and ");
  return [
    `restore point for ${m.restoresTo}`,
    `DB schema ${m.schemaVersion ?? "unknown"}, taken before ${steps || "a one-way change"}` +
      (m.createdBy ? ` by v${m.createdBy}` : ""),
  ];
};

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
for (const d of dirs) {
  const full = path.join(pinned, d);
  console.log(
    `  ${full}\n${describe(full)
      .map((l) => `    ${l}`)
      .join("\n")}`,
  );
}
if (!yes) {
  console.log(
    "Keep them until this version is known good. Delete them with: vp run purge-plaintext-backups --yes",
  );
  process.exit(0);
}
for (const d of dirs) fs.rmSync(path.join(pinned, d), { recursive: true, force: true });
console.log(`Deleted ${dirs.length} backup(s).`);
