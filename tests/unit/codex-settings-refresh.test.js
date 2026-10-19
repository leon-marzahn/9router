import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const readSource = (relativePath) =>
  readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("Codex settings refresh", () => {
  it("bypasses cached status after applying a selected endpoint", async () => {
    const [routeSource, panelSource] = await Promise.all([
      readSource("../../src/app/api/cli-tools/codex-settings/route.js"),
      readSource("../../src/app/(dashboard)/dashboard/cli-tools/connect/ConnectPanel.tsx"),
    ]);

    // Route Handlers already run on the server; a Server Action directive would reject this export.
    expect(routeSource).not.toContain('"use server";');
    expect(routeSource).toContain('export const dynamic = "force-dynamic";');
    // The shared panel re-reads the settings uncached after every write.
    expect(panelSource).toContain('fetch(settingsUrl(toolId, scope), { cache: "no-store" })');
  });
});
