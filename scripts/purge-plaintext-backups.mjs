#!/usr/bin/env node
// Delete the backups that still hold provider credentials in plaintext:
// DATA_DIR/db/pinned-backups/pre-encrypt-credentials-* (the restore points taken right
// before credentials were encrypted, see src/lib/db/backup.js).
//
//   vp run purge-plaintext-backups          list them
//   vp run purge-plaintext-backups --yes    delete them
//
// Run it once the encrypted install is known good: afterwards a downgrade to a version
// without credential encryption can no longer restore from these backups.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { defaultDataDir } = require("../src/lib/appDir.cjs");

const dataDir = process.env.DATA_DIR || defaultDataDir();
const pinned = path.join(dataDir, "db", "pinned-backups");
const dirs = fs.existsSync(pinned)
  ? fs
      .readdirSync(pinned)
      .filter((d) => d.startsWith("pre-encrypt-credentials-"))
      .map((d) => path.join(pinned, d))
  : [];

if (!dirs.length) {
  console.log(`No plaintext credential backups in ${pinned}.`);
  process.exit(0);
}
if (!process.argv.includes("--yes")) {
  console.log(
    `These backups hold provider credentials in plaintext:\n${dirs.map((d) => `  ${d}`).join("\n")}`,
  );
  console.log(
    "They are your restore point for a downgrade. Delete them with: vp run purge-plaintext-backups --yes",
  );
  process.exit(0);
}
for (const d of dirs) {
  fs.rmSync(d, { recursive: true, force: true });
  console.log(`Deleted ${d}`);
}
