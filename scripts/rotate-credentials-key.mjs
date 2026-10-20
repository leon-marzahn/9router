#!/usr/bin/env node
// Rotate the credentials encryption key (see src/lib/credentials/keyring.js).
//
//   vp run rotate-credentials-key            (DATA_DIR as the server uses it)
//
// Key file mode (no CREDENTIALS_KEY): moves the current DATA_DIR/credentials.key into
// DATA_DIR/credentials.key.previous and writes a new key. The next server start
// re-encrypts every stored credential under the new key (after a backup) and VACUUMs.
// Env mode (CREDENTIALS_KEY set): prints a new key and the env vars to set; nothing is written.
//
// After a successful start ("[DB][migrate] credentials encrypted" in the log) the old key is
// only needed to open backups taken before the rotation.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { defaultDataDir } = require("../src/lib/appDir.cjs");

const dataDir = process.env.DATA_DIR || defaultDataDir();
const keyFile = path.join(dataDir, "credentials.key");
const prevFile = path.join(dataDir, "credentials.key.previous");
const newKey = crypto.randomBytes(32).toString("base64");

if (process.env.CREDENTIALS_KEY) {
  console.log(`CREDENTIALS_KEY is set, so the key lives in your environment. To rotate:
  1. Stop the server.
  2. Set CREDENTIALS_KEY_PREVIOUS=<the current CREDENTIALS_KEY> and CREDENTIALS_KEY=${newKey}
  3. Start the server: it re-encrypts every credential under the new key.
  4. Remove CREDENTIALS_KEY_PREVIOUS once the start succeeded (keep the old key with any older backups).`);
  process.exit(0);
}

if (!fs.existsSync(keyFile)) {
  console.error(
    `No key file at ${keyFile}. Start the server once (it creates one) or set CREDENTIALS_KEY.`,
  );
  process.exit(1);
}

const current = fs.readFileSync(keyFile, "utf8").trim();
fs.appendFileSync(prevFile, `${current}\n`, { mode: 0o600 });
fs.chmodSync(prevFile, 0o600);
const tmp = `${keyFile}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${newKey}\n`, { mode: 0o600, flag: "wx" });
fs.renameSync(tmp, keyFile);
console.log(`New key written to ${keyFile}; the old one is in ${prevFile}.
Restart the server: it re-encrypts every stored credential under the new key.
Back up the new key file with the database. Keep ${prevFile} only as long as you keep
backups taken before this rotation.`);
