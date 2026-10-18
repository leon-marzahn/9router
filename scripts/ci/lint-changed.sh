#!/usr/bin/env bash
# Lint only the files a PR changes. The repo has ~150 pre-existing React
# Compiler errors in upstream pages, so a whole-repo `vp lint` can't gate PRs;
# this fails on any error in a touched file instead (fix what you touch).
#   scripts/ci/lint-changed.sh <base-ref>   (default: origin/master)
set -euo pipefail
base="${1:-origin/master}"
files=()
while IFS= read -r f; do files+=("$f"); done < <(git diff --name-only --diff-filter=ACMR "$(git merge-base "$base" HEAD)" HEAD \
  | grep -E '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$' || true)
if [ "${#files[@]}" -eq 0 ]; then
  echo "No lintable files changed."
  exit 0
fi
printf 'Linting %s changed file(s):\n' "${#files[@]}"
printf '  %s\n' "${files[@]}"
bunx vp lint "${files[@]}"
