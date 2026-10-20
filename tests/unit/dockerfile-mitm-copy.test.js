// The Docker runner stage spawns src/mitm/server.js as a separate process, which
// Next's standalone tracing never sees. Every file it (transitively) requires by a
// relative path must therefore be copied explicitly in the Dockerfile.
import { describe, it, expect } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

function runnerCopies() {
  const text = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const runner = text.slice(text.indexOf("AS runner"));
  const copies = [];
  for (const m of runner.matchAll(/^COPY\s+--from=builder\s+\/app\/(\S+)\s+\S+/gm)) {
    copies.push(m[1].replace(/\/$/, ""));
  }
  return copies;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${spec} from ${path.relative(root, fromFile)}`);
}

function mitmFiles() {
  const entries = ["server.js", "manager.js"].map((f) => path.join(root, "src/mitm", f));
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      queue.push(resolveRelative(file, m[1]));
    }
  }
  return [...seen].map((f) => path.relative(root, f).split(path.sep).join("/"));
}

describe("Dockerfile copies everything the MITM process requires", () => {
  it("covers every relative require reachable from src/mitm", () => {
    const copies = runnerCopies();
    expect(copies).toContain("src/mitm");
    const missing = mitmFiles().filter(
      (file) => !copies.some((c) => file === c || file.startsWith(`${c}/`)),
    );
    expect(missing).toEqual([]);
  });
});
