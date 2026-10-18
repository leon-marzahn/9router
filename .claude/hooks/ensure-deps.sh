#!/bin/sh
# SessionStart: a fresh git worktree has no node_modules. Install once so
# typecheck, lint, tests and the dev server work. Quiet when already installed.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -d node_modules ] && exit 0
echo "node_modules missing; installing dependencies (fresh worktree)…"
if command -v vp >/dev/null 2>&1; then
  vp install --frozen-lockfile >/dev/null 2>&1 && echo "Installed with vp (bun)." && exit 0
fi
if command -v bun >/dev/null 2>&1; then
  bun install --frozen-lockfile >/dev/null 2>&1 && echo "Installed with bun." && exit 0
fi
echo "Dependency install failed; install bun (https://bun.sh) and run 'bun install' before typechecking or testing."
exit 0
