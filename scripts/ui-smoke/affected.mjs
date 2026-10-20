// Which smoke routes/states a change can affect (scripts/ui-smoke.mjs --changed).
//
// - A file under a page dir (src/app/**/dashboard/<section>/…, src/app/**/customer/…)
//   affects that section, plus every section with a file importing from it
//   (relative or `@/app/…` specifiers, resolved against the importing file).
// - An API route src/app/api/<x>/** affects the sections whose files mention
//   `/api/<x>`; if shared UI (src/ui) calls it, everything.
// - Anything else the app runs (src/**, open-sse/**, custom-server.js, configs,
//   deps) and the smoke/pr-shots scripts themselves: everything.
// - The rest (docs, tests, other scripts and workflows) only runs the core set,
//   which always runs as a cheap canary for app-wide breakage.
import { dirname, join, normalize } from "node:path";

/** Always checked, whatever changed. */
export const CORE_ROUTES = ["/dashboard", "/dashboard/endpoint", "/dashboard/providers"];

/** Changes here can break any page: run everything. */
const FULL = [
  /^src\//,
  /^open-sse\//,
  /^scripts\/ui-smoke/,
  /^scripts\/pr-shots/,
  /^\.github\/workflows\/ui-smoke\.yml$/,
  /^(package\.json|bun\.lock|next\.config\.mjs|tsconfig\.json|vite\.config\.ts|custom-server\.js|\.node-version)$/,
  /^(postcss|tailwind)\.config\.[mc]?js$/,
];

/** `src/app/(group)/dashboard/usage/x.tsx` -> "/dashboard/usage"; null if not a page dir. */
export function sectionOf(file) {
  const m = file.match(/^src\/app\/(?:\([^/]+\)\/)*(dashboard|customer)\/(.+)$/);
  if (!m) return null;
  if (m[1] === "customer") return "/customer";
  const sub = m[2].split("/");
  // A file directly in the dashboard dir (page.js, loading.js) is the /dashboard home.
  return sub.length > 1 ? `/dashboard/${sub[0]}` : "/dashboard";
}

/** `src/app/api/usage/[id]/route.js` -> "usage"; null if not an API route. */
export function apiOf(file) {
  return file.match(/^src\/app\/api\/([^/]+)\//)?.[1] ?? null;
}

/** Import specifiers of a JS/TS source, resolved to repo-relative paths (no extension). */
export function importsOf(file, code) {
  const out = [];
  for (const m of code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith(".")) out.push(normalize(join(dirname(file), spec)));
    else if (spec.startsWith("@/")) out.push(`src/${spec.slice(2)}`);
  }
  return out;
}

/**
 * @param {string[]} files changed paths, repo-relative
 * @param {Map<string, string>} [sources] repo-relative path -> code of the files
 *   under src/app (pages) and src/ui, for import and API lookups
 * @returns {{ full: true, reason: string } | { full: false, sections: string[] }}
 */
export function affectedSections(files, sources = new Map()) {
  const sections = new Set();
  const add = (s) => {
    sections.add(s);
    // Sections that import from s (one level is enough for page dirs).
    for (const [path, code] of sources) {
      const from = sectionOf(path);
      if (!from || from === s) continue;
      if (importsOf(path, code).some((p) => sectionOf(p) === s)) sections.add(from);
    }
  };
  for (const f of files) {
    const section = sectionOf(f);
    if (section) {
      add(section);
      continue;
    }
    const api = apiOf(f);
    if (api) {
      const mention = new RegExp(`/api/${api.replace(/[-.]/g, "\\$&")}(?=[/"'\`?$]|$)`);
      for (const [path, code] of sources) {
        if (!mention.test(code)) continue;
        if (path.startsWith("src/ui/")) return { full: true, reason: `${f} (used by ${path})` };
        const s = sectionOf(path);
        if (s) add(s);
      }
      continue;
    }
    if (FULL.some((re) => re.test(f))) return { full: true, reason: f };
  }
  return { full: false, sections: [...sections].sort((a, b) => a.localeCompare(b)) };
}

/** Does `route` (path, may carry ?query or #hash) belong to one of `sections` or the core set? */
export function routeSelected(route, sections) {
  const path = route.replace(/[?#].*$/, "");
  if (CORE_ROUTES.includes(path)) return true;
  return sections.some((s) =>
    s === "/dashboard" ? path === "/dashboard" : path === s || path.startsWith(`${s}/`),
  );
}
