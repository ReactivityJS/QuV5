#!/usr/bin/env sh
# Exports packages/lite into its own repository - WITH its git history.
#
#   scripts/export-lite.sh                         # -> local branch `lite-standalone`
#   scripts/export-lite.sh git@github.com:ORG/qu-lite.git   # ... and push it there as `main`
#
# The branch contains only packages/lite, moved to the repository root
# (git subtree split): every commit that touched it, with the same messages
# and authors. The package is self-contained - package.json, package-lock.json,
# Dockerfile, docker-compose.yml, CI workflow, LICENSE - so in the new repo:
#
#   npm ci && npm test && docker compose up --build
#
# Requires a clean working tree (only committed changes are exported).
set -eu
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain -- packages/lite)" ]; then
  echo "packages/lite has uncommitted changes - commit them first" >&2
  exit 1
fi
git branch -D lite-standalone >/dev/null 2>&1 || true
git subtree split --prefix=packages/lite -b lite-standalone
echo "branch lite-standalone: $(git rev-list --count lite-standalone) commits"
if [ "${1:-}" != "" ]; then
  git push "$1" lite-standalone:main
  echo "pushed to $1 (main)"
fi
