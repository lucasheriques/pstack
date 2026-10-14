#!/usr/bin/env bash
# Mirrors cursor/plugins' current pstack/ onto the `upstream` branch as one commit, then pushes it.
# Idempotent: exits 0 without committing when nothing changed.
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
scratch=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$scratch/upstream" 2>/dev/null || true; rm -rf "$scratch"' EXIT

# The merge model needs `upstream` to advance linearly on the remote, so start from origin's tip.
git -C "$repo" fetch -q origin upstream main
if ! git -C "$repo" merge-base --is-ancestor upstream origin/upstream; then
  echo "local upstream has commits origin/upstream lacks; push or reset it first" >&2
  exit 1
fi
git -C "$repo" branch -f upstream origin/upstream

last_synced=$(git -C "$repo" log -1 --format=%s upstream | grep -oE '@[0-9a-f]+$' | tr -d @)

# A squash-merged sync drops `upstream` from main's ancestry, and the next merge
# then re-conflicts on every line an earlier sync resolved. The squash body still
# names the mirror, which tells a squash apart from a sync that never landed.
if ! git -C "$repo" merge-base --is-ancestor upstream origin/main; then
  previous=$(git -C "$repo" rev-parse --short upstream)
  if [ -z "$(git -C "$repo" log origin/main --format=%h --grep="pstack@$last_synced")" ]; then
    echo "warning: the sync of upstream@$previous has not landed on main. Land it before syncing again." >&2
  elif ! git -C "$repo" merge-base --is-ancestor upstream HEAD; then
    echo "warning: main squash-merged the sync of upstream@$previous, so it lacks that mirror in its ancestry." >&2
    echo "  Restore it before merging: git merge -s ours $previous" >&2
  fi
fi
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/cursor/plugins "$scratch/plugins"
git -C "$scratch/plugins" sparse-checkout set pstack
sha=$(git -C "$scratch/plugins" rev-parse HEAD)

git -C "$repo" worktree add -q "$scratch/upstream" upstream
rsync -a --delete --exclude .git "$scratch/plugins/pstack/" "$scratch/upstream/"
git -C "$scratch/upstream" add -A

if git -C "$scratch/upstream" diff --cached --quiet; then
  echo "upstream unchanged since cursor/plugins@$last_synced"
else
  git -C "$scratch/upstream" commit -q -m "upstream: sync cursor/plugins pstack@${sha:0:12}" \
    -m "Verbatim mirror of https://github.com/cursor/plugins/tree/$sha/pstack."
  git -C "$repo" push -q origin upstream
  echo "upstream synced cursor/plugins@$last_synced -> @${sha:0:12}"
  git -C "$repo" diff --stat upstream~1 upstream | tail -1
fi
