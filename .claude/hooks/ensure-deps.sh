#!/bin/sh
# SessionStart: put bun and Vite+ on PATH for the session (the user's shell
# defines `vp` as a function, which non-interactive shells don't see), and
# make node_modules match bun.lock. A fresh or half-installed worktree gets a
# full install; an up-to-date one is a ~1s no-op, so this runs every session.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
for d in "$HOME/.local/share/vite-plus/bin" "$HOME/.bun/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
[ -n "$CLAUDE_ENV_FILE" ] && echo "export PATH=\"$PATH\"" >> "$CLAUDE_ENV_FILE"
if command -v vp >/dev/null 2>&1; then
  vp install --frozen-lockfile >/dev/null 2>&1 && exit 0
fi
if command -v bun >/dev/null 2>&1; then
  bun install --frozen-lockfile >/dev/null 2>&1 && exit 0
fi
echo "Dependency install failed; run 'bun install --frozen-lockfile' before typechecking or testing."
exit 0
