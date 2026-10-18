// Node module hooks so plain `node` can import the app's DB layer, which uses
// the `@/` (src/) and `open-sse/` aliases and some extensionless specifiers.
import { existsSync, statSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function withExtension(path) {
  if (existsSync(path) && statSync(path).isFile()) return path;
  for (const ext of [".js", ".mjs", ".ts", "/index.js"])
    if (existsSync(path + ext)) return path + ext;
  return path;
}

export async function resolve(specifier, context, next) {
  let target = null;
  if (specifier.startsWith("@/")) target = root + "src/" + specifier.slice(2);
  else if (specifier === "open-sse") target = root + "open-sse/index.js";
  else if (specifier.startsWith("open-sse/")) target = root + specifier;
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    target = fileURLToPath(new URL(specifier, context.parentURL));
  }
  if (target) return next(pathToFileURL(withExtension(target)).href, context);
  return next(specifier, context);
}
