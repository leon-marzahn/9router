import { describe, it, expect, beforeEach } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  writeConfigFile,
  removeConfigFile,
  listBackups,
  restoreBackups,
  BACKUP_SUFFIX,
} from "../../src/app/api/cli-tools/configFile.js";

const mode = (p) => fs.statSync(p).mode & 0o777;
let dir;
let n = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-backup-"));
});

const tool = () => `test-tool-${++n}`;

describe("CLI tool config writes", () => {
  it("creates new files 0600 without a backup", async () => {
    const t = tool();
    const file = path.join(dir, "new.json");
    await writeConfigFile(t, file, "{}");
    if (process.platform !== "win32") expect(mode(file)).toBe(0o600);
    expect(fs.existsSync(file + BACKUP_SUFFIX)).toBe(false);
    expect(await listBackups(t)).toEqual([]);
  });

  it("backs up the previous content and tightens a 0644 file", async () => {
    const t = tool();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "original", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    await writeConfigFile(t, file, "ours");
    expect(fs.readFileSync(file + BACKUP_SUFFIX, "utf-8")).toBe("original");
    if (process.platform !== "win32") {
      expect(mode(file)).toBe(0o600);
      expect(mode(file + BACKUP_SUFFIX)).toBe(0o600);
    }
    // A second write in the same Apply keeps the user's original as the backup.
    await writeConfigFile(t, file, "ours again");
    expect(fs.readFileSync(file + BACKUP_SUFFIX, "utf-8")).toBe("original");
  });

  it("never loosens a stricter mode", async () => {
    if (process.platform === "win32") return;
    const file = path.join(dir, "strict");
    fs.writeFileSync(file, "x");
    fs.chmodSync(file, 0o600);
    await writeConfigFile(tool(), file, "y");
    expect(mode(file)).toBe(0o600);
    // Group/other bits are never added to an existing 0600 file.
    expect(mode(file) & 0o077).toBe(0);
  });

  it("restores the previous content and drops the backup", async () => {
    const t = tool();
    const a = path.join(dir, "a.toml");
    const b = path.join(dir, "b.env");
    fs.writeFileSync(a, "A0");
    fs.writeFileSync(b, "B0");
    await writeConfigFile(t, a, "A1");
    await removeConfigFile(t, b);
    expect(fs.existsSync(b)).toBe(false);
    expect((await listBackups(t)).sort()).toEqual([a, b].sort());

    const restored = await restoreBackups(t);
    expect(restored.sort()).toEqual([a, b].sort());
    expect(fs.readFileSync(a, "utf-8")).toBe("A0");
    expect(fs.readFileSync(b, "utf-8")).toBe("B0");
    expect(fs.existsSync(a + BACKUP_SUFFIX)).toBe(false);
    expect(await listBackups(t)).toEqual([]);
  });
});
