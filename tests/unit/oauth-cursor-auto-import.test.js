// Rewritten for the current route (a6c764d7 / 8312af79): candidate-path probing per
// platform, better-sqlite3 -> sqlite3 CLI -> manual-paste fallback, and a Linux
// "is Cursor installed" check. The previous suite targeted an older implementation
// (bulk IN query, fuzzy LIKE fallback, 400 for unsupported platforms) that no longer exists.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import * as fsPromises from "fs/promises";
import * as childProcess from "child_process";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({ status: init?.status || 200, body, json: async () => body })),
  },
}));

vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// sqlite3 CLI / `which` stub. promisify(execFile) resolves with the callback's value.
vi.mock("child_process", () => ({ execFile: vi.fn() }));

// better-sqlite3 is loaded with require() and cannot open the mocked path, so every
// extraction below exercises the CLI fallback deterministically.
vi.mock("better-sqlite3", () => ({
  default: class { constructor() { throw new Error("SQLITE_CANTOPEN"); } },
}));

let GET;

function stubCli(values) {
  vi.mocked(childProcess.execFile).mockImplementation((cmd, args, opts, cb) => {
    if (cmd === "which") return cb(null, { stdout: "/usr/bin/cursor\n" });
    const sql = args[1];
    const key = Object.keys(values).find((k) => sql.includes(`key='${k}'`));
    cb(null, { stdout: key ? `${values[key]}\n` : "" });
  });
}

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    ({ GET } = await import("../../src/app/api/oauth/cursor/auto-import/route.js"));
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("returns not-found listing every macOS candidate when none is readable", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));
    const res = await GET();
    expect(res.body.found).toBe(false);
    expect(res.body.error).toContain("Cursor database not found");
    expect(res.body.error).toContain("/mock/home/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    expect(res.body.error).toContain("Cursor - Insiders");
  });

  it("extracts tokens using the exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubCli({ "cursorAuth/accessToken": "test-token", "storage.serviceMachineId": "test-machine-id" });
    const res = await GET();
    expect(res.body).toEqual({ found: true, accessToken: "test-token", machineId: "test-machine-id" });
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubCli({ "cursorAuth/accessToken": '"json-token"', "storage.machineId": '"json-machine-id"' });
    const res = await GET();
    expect(res.body.found).toBe(true);
    expect(res.body.accessToken).toBe("json-token");
    expect(res.body.machineId).toBe("json-machine-id");
  });

  it("falls back to manual paste when tokens are missing", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubCli({});
    const res = await GET();
    expect(res.body.found).toBe(false);
    expect(res.body.windowsManual).toBe(true);
    expect(res.body.dbPath).toContain("state.vscdb");
  });

  it("linux skips import when config exists but Cursor is not installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    // First access (db candidate) succeeds; the .desktop probe fails.
    vi.mocked(fsPromises.access).mockResolvedValueOnce().mockRejectedValue(new Error("ENOENT"));
    vi.mocked(childProcess.execFile).mockImplementation((cmd, args, opts, cb) => cb(new Error("not found")));
    const res = await GET();
    expect(res.body.found).toBe(false);
    expect(res.body.error).toContain("does not appear to be installed");
  });

  it("linux probes the ~/.config candidates", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));
    const res = await GET();
    expect(res.body.found).toBe(false);
    expect(res.body.error).toContain("/mock/home/.config/Cursor/User/globalStorage/state.vscdb");
  });
});
