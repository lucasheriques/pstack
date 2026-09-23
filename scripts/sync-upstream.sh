#!/usr/bin/env bash
# Mirrors cursor/plugins' current pstack/ onto the `upstream` branch as one commit.
# Idempotent: prints the synced SHA and exits 0 without committing when nothing changed.
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
scratch=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$scratch/upstream" 2>/dev/null || true; rm -rf "$scratch"' EXIT

git clone -q --depth 1 --filter=blob:none --sparse https://github.com/cursor/plugins "$scratch/plugins"
git -C "$scratch/plugins" sparse-checkout set pstack
sha=$(git -C "$scratch/plugins" rev-parse HEAD)

git -C "$repo" worktree add -q "$scratch/upstream" upstream
rsync -a --delete --exclude .git "$scratch/plugins/pstack/" "$scratch/upstream/"
git -C "$scratch/upstream" add -A

if git -C "$scratch/upstream" diff --cached --quiet; then
  echo "upstream already at cursor/plugins@${sha:0:12}"
else
  git -C "$scratch/upstream" commit -q -m "upstream: sync cursor/plugins pstack@${sha:0:12}" \
    -m "Verbatim mirror of https://github.com/cursor/plugins/tree/$sha/pstack."
  echo "upstream synced to cursor/plugins@${sha:0:12}"
  git -C "$repo" diff --stat upstream~1 upstream | tail -1
fi
