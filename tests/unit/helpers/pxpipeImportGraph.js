import fs from "node:fs";
import path from "node:path";

// Static import graph of an ESM entry: every file reached through relative
// imports, plus every specifier that is not relative (bare package or node:).
// The pin hashes only pxpipe-proxy's own files, so the loaded graph must not
// reach outside the package.
export function importGraph(entry) {
  const files = new Set();
  const external = [];
  const queue = [path.resolve(entry)];
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(path.resolve(path.dirname(file), spec));
      } else {
        external.push(`${spec} <- ${path.basename(file)}`);
      }
    }
  }
  return { files: [...files], external };
}
