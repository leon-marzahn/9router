// 421f2262 / 00dd3dfc, ported to the fork's media workbench: Codex STT reuses the Codex
// OAuth sign-ins (the note shows on the STT kind only), and the example only offers the
// response formats the model declares.
import { it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import codex from "../../open-sse/providers/registry/codex.js";

const root = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

it("documents OAuth reuse, ffmpeg limits and does not offer unsupported response formats", () => {
  expect(codex.display.kindNotice.stt).toContain("ffmpeg");
  const transcribe = codex.models.find((m) => m.id === "transcribe");
  expect(transcribe.responseFormats).toEqual(["json", "text"]);

  const detail = read("src/app/(dashboard)/dashboard/media-providers/workbench/MediaDetail.tsx");
  expect(detail).toContain('kind.id === "stt" && !p.custom && p.id in OAUTH_PROVIDERS');
  expect(detail).toContain("href={`/dashboard/providers?p=${encodeURIComponent(p.id)}`}");

  const example = read("src/app/(dashboard)/dashboard/media-providers/workbench/examples/SttExample.tsx");
  expect(example).toContain("selected?.responseFormats");

  expect(read("Dockerfile").split("AS runner")[1]).toContain("su-exec ffmpeg");
});
