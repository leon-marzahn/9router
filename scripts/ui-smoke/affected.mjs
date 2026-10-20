// Which smoke routes/states a change can affect (scripts/ui-smoke.mjs --changed).
//
// A file under a page dir (src/app/**/dashboard/<section>/…, src/app/**/customer/…)
// affects the routes and states under that section, plus sections that import
// from it. Shared UI (src/ui, layouts, globals.css, legacy shared components,
// next.config, deps) and the smoke/pr-shots scripts themselves affect everything.
// Anything else (API routes, backend, docs, tests) only runs the core set, which
// always runs: a cheap canary for app-wide breakage.

/** Always checked, whatever changed. */
export const CORE_ROUTES = ["/dashboard", "/dashboard/endpoint", "/dashboard/providers"];

/** Changes here can break any page: run everything. */
const FULL = [
  /^src\/ui\//,
  /^src\/app\/(\([^/]+\)\/)?(dashboard\/)?layout\.[jt]sx?$/,
  /^src\/app\/[^/]*\.css$/,
  /^src\/app\/\([^/]+\)\/layout\.[jt]sx?$/,
  /^src\/shared\/(components|hooks|constants)\//,
  /^src\/(store|i18n)\//,
  /^src\/proxy\.[jt]s$/,
  /^src\/middleware\.[jt]s$/,
  /^scripts\/ui-smoke/,
  /^scripts\/pr-shots/,
  /^\.github\/workflows\/ui-smoke\.yml$/,
  /^(package\.json|bun\.lock|next\.config\.mjs|tsconfig\.json|postcss\.config\.m?js|tailwind\.config\.[mc]?js)$/,
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

/**
 * @param {string[]} files changed paths, repo-relative
 * @param {{ importers?: (section: string) => string[] }} [opts] importers(section)
 *   returns other sections whose files import from that section's dir
 * @returns {{ full: true, reason: string } | { full: false, sections: string[] }}
 */
export function affectedSections(files, opts = {}) {
  const sections = new Set();
  for (const f of files) {
    const hit = FULL.find((re) => re.test(f));
    if (hit) return { full: true, reason: f };
    const s = sectionOf(f);
    if (!s) continue;
    sections.add(s);
    for (const other of opts.importers?.(s) ?? []) sections.add(other);
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
