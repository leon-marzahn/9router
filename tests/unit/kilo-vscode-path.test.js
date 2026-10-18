import { describe, it, expect } from "vite-plus/test";
import path from "path";
import { vscodeUserDir } from "../../src/app/api/cli-tools/kilo-settings/vscodePaths.js";

describe("Kilo VS Code settings path", () => {
  it("uses the per-platform VS Code user dir", () => {
    expect(vscodeUserDir("darwin", "/Users/u", {})).toBe(path.join("/Users/u", "Library", "Application Support", "Code", "User"));
    expect(vscodeUserDir("win32", "C:/Users/u", { APPDATA: "C:/Users/u/AppData/Roaming" }))
      .toBe(path.join("C:/Users/u/AppData/Roaming", "Code", "User"));
    expect(vscodeUserDir("linux", "/home/u", {})).toBe(path.join("/home/u", ".config", "Code", "User"));
    expect(vscodeUserDir("linux", "/home/u", { XDG_CONFIG_HOME: "/xdg" })).toBe(path.join("/xdg", "Code", "User"));
  });
});
