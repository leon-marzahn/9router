const fs = require("fs");
const path = require("path");
const { APP_NAME, defaultDataDir: defaultDir } = require("../lib/appDir.cjs");

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

module.exports = { DATA_DIR, MITM_DIR };
