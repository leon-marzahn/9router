import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// npm and the network are mocked: spawn writes a fake package into DATA_DIR
// (a per-run temp dir) the way `npm install` would, and execSync finds "npm".
const state = vi.hoisted(() => ({ pin: null, onSpawn: null, spawnCalls: [] }));

vi.mock("child_process", async (orig) => {
  const actual = await orig();
  const spawn = (cmd, args, opts) => {
    state.spawnCalls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      state.onSpawn?.(opts.cwd);
      child.emit("exit", 0);
    });
    return child;
  };
  const execSync = () => Buffer.from("/usr/bin/npm\n");
  return { ...actual, default: { ...actual, spawn, execSync }, spawn, execSync };
});

vi.mock("../../src/lib/pxpipe/pin.js", async (orig) => {
  const actual = await orig();
  return { ...actual, defaultPin: () => state.pin };
});

import { importGraph } from "./helpers/pxpipeImportGraph.js";

const pinMod = await import("../../src/lib/pxpipe/pin.js");
const install = await import("../../src/lib/pxpipe/install.js");
const loader = await import("../../src/lib/pxpipe/loader.js");
const service = await import("../../src/lib/pxpipe/service.js");

const INTEGRITY = pinMod.PXPIPE_INTEGRITY;
const VERSION = pinMod.PXPIPE_VERSION;

// Lay out what a pinned npm install leaves behind: package + lockfile.
function writeFakeInstall(hostDir, { version = VERSION, integrity = INTEGRITY } = {}) {
  const root = path.join(hostDir, "node_modules", "pxpipe-proxy");
  fs.mkdirSync(path.join(root, "dist", "core"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "pxpipe-proxy", version, type: "module" }),
  );
  fs.writeFileSync(
    path.join(root, "dist", "core", "library.js"),
    `export async function transformAnthropicMessages(i) {
       return { applied: false, reason: "below-threshold", body: i.body };
     }`,
  );
  fs.writeFileSync(
    path.join(hostDir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/pxpipe-proxy": { version, integrity } },
    }),
  );
  return root;
}

function pinTo(root) {
  state.pin = { version: VERSION, integrity: INTEGRITY, treeSha256: pinMod.treeHash(root) };
}

beforeEach(() => {
  fs.rmSync(install.PXPIPE_DIR, { recursive: true, force: true });
  loader.unloadPxpipe();
  loader.clearPinFailure();
  state.spawnCalls = [];
  state.onSpawn = null;
});
afterEach(() => {
  fs.rmSync(install.PXPIPE_DIR, { recursive: true, force: true });
});

describe("pinned install command", () => {
  it("pins pxpipe-proxy to an exact version and integrity", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    expect(pinMod.PXPIPE_TREE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("installs the exact spec with scripts off, an explicit registry and a lockfile", async () => {
    state.onSpawn = (cwd) => pinTo(writeFakeInstall(cwd));
    // A planted project .npmrc must not survive into the install.
    fs.mkdirSync(install.PXPIPE_DIR, { recursive: true });
    fs.writeFileSync(path.join(install.PXPIPE_DIR, ".npmrc"), "registry=https://evil.example/\n");

    await install.installPxpipe();

    expect(state.spawnCalls).toHaveLength(1);
    const { args, opts } = state.spawnCalls[0];
    expect(args[0]).toBe("install");
    expect(args[1]).toBe(`pxpipe-proxy@${VERSION}`);
    expect(args).not.toContain("pxpipe-proxy@latest");
    expect(args).toEqual(
      expect.arrayContaining([
        "--save-exact",
        "--ignore-scripts",
        "--registry=https://registry.npmjs.org/",
        "--package-lock=true",
      ]),
    );
    expect(opts.env.npm_config_ignore_scripts).toBe("true");
    expect(fs.existsSync(path.join(install.PXPIPE_DIR, ".npmrc"))).toBe(false);
  });

  it("reinstall wipes a tampered copy and lockfile before npm runs", async () => {
    const root = writeFakeInstall(install.PXPIPE_DIR);
    fs.appendFileSync(path.join(root, "dist", "core", "library.js"), "\n// tampered\n");
    let sawOld = null;
    state.onSpawn = (cwd) => {
      sawOld =
        fs.existsSync(path.join(cwd, "node_modules")) ||
        fs.existsSync(path.join(cwd, "package-lock.json"));
      pinTo(writeFakeInstall(cwd));
    };
    await install.installPxpipe();
    expect(sawOld).toBe(false);
    expect(install.verifyInstall().ok).toBe(true);
  });

  it("fails the install when npm leaves a different version behind", async () => {
    state.onSpawn = (cwd) => {
      const root = writeFakeInstall(cwd);
      pinTo(root);
      writeFakeInstall(cwd, { version: "9.9.9" });
    };
    await expect(install.installPxpipe()).rejects.toMatchObject({ code: "PIN_MISMATCH" });
  });
});

describe("loader refuses anything but the pinned release", () => {
  it("loads a matching install and the health check passes", async () => {
    pinTo(writeFakeInstall(install.PXPIPE_DIR));
    const loaded = await loader.loadPxpipe();
    expect(typeof loaded.module.transformAnthropicMessages).toBe("function");
    const health = await service.runHealthCheck();
    expect(health.healthy).toBe(true);
    expect(health.checks.find((c) => c.id === "pinned").ok).toBe(true);
  });

  it("refuses a version mismatch", async () => {
    const root = writeFakeInstall(install.PXPIPE_DIR);
    pinTo(root);
    const pkgPath = path.join(root, "package.json");
    fs.writeFileSync(pkgPath, fs.readFileSync(pkgPath, "utf8").replace(VERSION, "0.0.1"));
    await expect(loader.loadPxpipe()).rejects.toMatchObject({ code: "PIN_MISMATCH" });
    expect(await loader.getTransform()).toBeNull();
    const health = await service.runHealthCheck();
    expect(health).toMatchObject({ healthy: false, code: "PIN_MISMATCH" });
  });

  it("refuses a lockfile integrity mismatch", async () => {
    pinTo(writeFakeInstall(install.PXPIPE_DIR));
    state.pin = { ...state.pin, integrity: "sha512-AAAA" };
    await expect(loader.loadPxpipe()).rejects.toMatchObject({ code: "PIN_MISMATCH" });
  });

  it("refuses a file changed on disk and drops an already-loaded module", async () => {
    const root = writeFakeInstall(install.PXPIPE_DIR);
    pinTo(root);
    await loader.loadPxpipe();
    fs.appendFileSync(path.join(root, "dist", "core", "library.js"), "\n// tampered\n");

    const health = await service.runHealthCheck();
    expect(health).toMatchObject({ healthy: false, code: "PIN_MISMATCH" });
    expect(loader.getLoadedInfo().loaded).toBe(false);
    await expect(loader.loadPxpipe()).rejects.toMatchObject({ code: "PIN_MISMATCH" });
  });

  it("refuses an install without a lockfile", async () => {
    pinTo(writeFakeInstall(install.PXPIPE_DIR));
    fs.rmSync(path.join(install.PXPIPE_DIR, "package-lock.json"));
    await expect(loader.loadPxpipe()).rejects.toMatchObject({ code: "PIN_MISMATCH" });
  });

  it("reports not-installed with a code the UI can offer an install for", async () => {
    const health = await service.runHealthCheck();
    expect(health).toMatchObject({ healthy: false, code: "NOT_INSTALLED", pinnedVersion: VERSION });
  });
});

describe("pin details", () => {
  it("library.js's static import graph stays inside the package", () => {
    const root = writeFakeInstall(install.PXPIPE_DIR);
    const core = path.join(root, "dist", "core");
    fs.writeFileSync(path.join(core, "render.js"), "export const r = 1;\n");
    fs.writeFileSync(
      path.join(core, "library.js"),
      'import { r } from "./render.js";\nexport async function transformAnthropicMessages() { return r; }\n',
    );
    expect(importGraph(path.join(core, "library.js")).external).toEqual([]);

    // The check itself catches a bare or node: import.
    fs.appendFileSync(
      path.join(core, "render.js"),
      'import fs from "node:fs";\nimport t from "gpt-tokenizer";\n',
    );
    expect(importGraph(path.join(core, "library.js")).external).toEqual([
      "node:fs <- render.js",
      "gpt-tokenizer <- render.js",
    ]);
  });

  it("refuses an unreadable package.json", () => {
    const root = writeFakeInstall(install.PXPIPE_DIR);
    pinTo(root);
    fs.writeFileSync(path.join(root, "package.json"), "{not json");
    expect(install.verifyInstall()).toEqual({
      ok: false,
      reason: "package.json missing or unreadable",
    });
  });

  it("refuses when the package files cannot be hashed", () => {
    const root = writeFakeInstall(install.PXPIPE_DIR);
    pinTo(root);
    const locked = path.join(root, "dist", "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const res = install.verifyInstall();
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/^cannot hash package files/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("caches a failed verify until the next health run, and logs pin_mismatch", async () => {
    const root = writeFakeInstall(install.PXPIPE_DIR);
    pinTo(root);
    const lib = path.join(root, "dist", "core", "library.js");
    const original = fs.readFileSync(lib, "utf8");
    fs.appendFileSync(lib, "\n// tampered\n");
    expect(await loader.getTransform()).toBeNull();
    expect(loader.getUnavailableReason()).toBe("pin_mismatch");
    expect(service.getPxpipeStatus().pinMismatch).toBe(true);

    // Restored on disk, but requests keep skipping without re-hashing...
    fs.writeFileSync(lib, original);
    await expect(loader.loadPxpipe()).rejects.toMatchObject({ code: "PIN_MISMATCH" });
    // ...until a health run re-verifies.
    const health = await service.runHealthCheck();
    expect(health.healthy).toBe(true);
    expect(loader.getUnavailableReason()).toBeNull();

    const { compressWithPxpipe } = await import("../../open-sse/rtk/pxpipe.js");
    const res = await compressWithPxpipe(
      { messages: [] },
      { enabled: true, transform: null, unavailableReason: "pin_mismatch" },
    );
    expect(res.summary.reason).toBe("pin_mismatch");
  });

  it("health error text does not repeat the check detail", async () => {
    const root = writeFakeInstall(install.PXPIPE_DIR);
    pinTo(root);
    fs.appendFileSync(path.join(root, "dist", "core", "library.js"), "\n// x\n");
    const health = await service.runHealthCheck();
    expect(health.error).not.toContain("package files differ");
    expect(health.checks.find((c) => c.id === "pinned").detail).toContain("package files differ");
  });
});
