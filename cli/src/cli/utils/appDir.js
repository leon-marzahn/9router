// Default data directory for the CLI.
// the CLI. Copy of src/lib/appDir.cjs (the CLI package ships separately) — keep in sync.
//
// The fork used to store data in ~/.9router (%APPDATA%\9router on Windows).
// On first start after the rename it is moved to ~/.regent in one atomic
// rename; if that fails (e.g. permissions) the legacy folder keeps being used.
const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "regent";
const LEGACY_APP_NAME = "9router";

function dirFor(name) {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), name);
  }
  return path.join(os.homedir(), `.${name}`);
}

let resolved = null;

function defaultDataDir() {
  if (resolved) return resolved;
  const current = dirFor(APP_NAME);
  const legacy = dirFor(LEGACY_APP_NAME);
  if (!fs.existsSync(current) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, current);
      console.log(`[DATA_DIR] moved ${legacy} → ${current}`);
    } catch (e) {
      // Another process may have just moved it; otherwise stay on the legacy dir.
      if (!fs.existsSync(current)) {
        console.warn(`[DATA_DIR] could not move ${legacy} → ${current} (${e.code || e.message}); using ${legacy}`);
        resolved = legacy;
        return resolved;
      }
    }
  }
  resolved = current;
  return resolved;
}

module.exports = { APP_NAME, LEGACY_APP_NAME, dirFor, defaultDataDir };
