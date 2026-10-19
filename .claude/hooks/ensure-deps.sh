#!/bin/sh
# SessionStart: put bun and Vite+ on PATH for the session (the user's shell
# defines `vp` as a function, which non-interactive shells don't see), and
# install node_modules once in a fresh worktree.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
for d in "$HOME/.local/share/vite-plus/bin" "$HOME/.bun/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
[ -n "$CLAUDE_ENV_FILE" ] && echo "export PATH=\"$PATH\"" >> "$CLAUDE_ENV_FILE"
[ -d node_modules ] && exit 0
echo "node_modules missing; installing dependencies (fresh worktree)…"
if command -v vp >/dev/null 2>&1; then
  vp install --frozen-lockfile >/dev/null 2>&1 && echo "Installed with vp (bun)." && exit 0
fi
if command -v bun >/dev/null 2>&1; then
  bun install --frozen-lockfile >/dev/null 2>&1 && echo "Installed with bun." && exit 0
fi
echo "Dependency install failed; run 'bun install --frozen-lockfile' before typechecking or testing."
exit 0
