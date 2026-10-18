#!/bin/sh
# SessionStart: a fresh git worktree has no node_modules. Install once so
# typecheck, lint, tests and the dev server work. Quiet when already installed.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -d node_modules ] && exit 0
echo "node_modules missing; installing dependencies (fresh worktree)…"
if command -v vp >/dev/null 2>&1; then
  vp install >/dev/null 2>&1 && echo "Installed with vp." && exit 0
fi
npm ci --no-audit --no-fund >/dev/null 2>&1 && echo "Installed with npm ci." && exit 0
echo "Dependency install failed; run 'vp install' (or 'npm install') before typechecking or testing."
exit 0
