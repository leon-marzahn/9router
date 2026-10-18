// Every config file a CLI tool route writes or deletes goes through here, so that:
//   - the file holds API keys → it is created 0600, and a rewrite never loosens the mode;
//   - one rolling backup `<file>.regent.bak` of the previous content is kept, which the
//     "Restore previous" action (../restore/route.js) copies back. No backup is made when
//     the file did not exist yet.
// Which files a tool has backups for is recorded in `<DATA_DIR>/cli-tool-backups.json`.

import fs from "fs/promises";
import path from "path";
import { getDataDir } from "@/lib/dataDir.js";

export const BACKUP_SUFFIX = ".regent.bak";
const SECRET_MODE = 0o600;

// One Apply can rewrite the same file twice (e.g. a migration pass, then the real write).
// The backup must hold what the user had before the request, not our intermediate state.
const SAME_APPLY_MS = 5000;
const lastBackupAt = new Map();

const manifestPath = () => path.join(getDataDir(), "cli-tool-backups.json");

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

let manifestQueue = Promise.resolve();
function updateManifest(fn) {
  const run = manifestQueue.then(async () => {
    let manifest = {};
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath(), "utf-8")) || {};
    } catch {
      /* missing or unreadable: start over */
    }
    const next = fn(manifest) || manifest;
    await fs.mkdir(path.dirname(manifestPath()), { recursive: true });
    await fs.writeFile(manifestPath(), JSON.stringify(next, null, 2), { mode: SECRET_MODE });
    return next;
  });
  manifestQueue = run.catch(() => {});
  return run;
}

async function readManifest() {
  await manifestQueue;
  try {
    return JSON.parse(await fs.readFile(manifestPath(), "utf-8")) || {};
  } catch {
    return {};
  }
}

async function backup(toolId, filePath) {
  const resolved = path.resolve(filePath);
  if (!(await statOrNull(resolved))) return;
  const last = lastBackupAt.get(resolved);
  if (last && Date.now() - last < SAME_APPLY_MS) return;
  const bak = resolved + BACKUP_SUFFIX;
  await fs.copyFile(resolved, bak);
  await fs.chmod(bak, SECRET_MODE);
  lastBackupAt.set(resolved, Date.now());
  await updateManifest((m) => {
    const files = new Set(m[toolId] || []);
    files.add(resolved);
    m[toolId] = [...files];
  });
}

// Write `data`, backing up the previous content. New files are 0600; an existing file
// keeps at most its owner read/write bits (tightened, never loosened).
export async function writeConfigFile(toolId, filePath, data) {
  const before = await statOrNull(filePath);
  await backup(toolId, filePath);
  await fs.writeFile(filePath, data, { mode: SECRET_MODE });
  await fs.chmod(filePath, before ? before.mode & SECRET_MODE : SECRET_MODE);
}

export async function removeConfigFile(toolId, filePath) {
  await backup(toolId, filePath);
  await fs.rm(filePath, { force: true });
}

// Bound helpers for one tool's route module.
export function configWriter(toolId) {
  return {
    writeConfigFile: (filePath, data) => writeConfigFile(toolId, filePath, data),
    removeConfigFile: (filePath) => removeConfigFile(toolId, filePath),
  };
}

export async function listBackups(toolId) {
  const files = (await readManifest())[toolId] || [];
  const present = [];
  for (const file of files) {
    if (await statOrNull(file + BACKUP_SUFFIX)) present.push(file);
  }
  return present;
}

// Copy every backup of the tool back over its file, then drop the backups (restoring
// twice would otherwise "restore" the same content again).
export async function restoreBackups(toolId) {
  const files = await listBackups(toolId);
  for (const file of files) {
    const bak = file + BACKUP_SUFFIX;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(bak, file);
    await fs.chmod(file, SECRET_MODE);
    await fs.rm(bak, { force: true });
    lastBackupAt.delete(file);
  }
  await updateManifest((m) => {
    delete m[toolId];
  });
  return files;
}
