---
name: sync-upstream
description: Merge the latest cursor/plugins pstack into this Claude Code port. Use for "sync upstream", "update pstack from cursor", "pull poteto's changes", or when upstream pstack has new commits.
---

# Sync upstream

This repo is two branches. `upstream` is a verbatim mirror of `cursor/plugins/pstack`, one commit per sync. `main` is the Claude Code port, and it merges `upstream`, so every sync is a real 3-way merge: upstream's edits land on top of the port's translations, and only lines both sides touched conflict.

## Steps

1. **Branch.** From a worktree off `main`, create `sync/upstream-<date>`.
2. **Mirror.** Run `scripts/sync-upstream.sh`. It fast-forwards `upstream` from `origin`, commits the new snapshot, and pushes it, or reports that nothing changed. If nothing changed, stop and say so.
3. **Read why.** `gh api --paginate 'repos/cursor/plugins/commits?path=pstack&per_page=100'` lists upstream's commits. Read down to the previously synced SHA, which the script printed. Read the messages of the new ones so the merge preserves poteto's intent, not just the text.
4. **Merge.** `git merge upstream`. Resolve each conflict per `references/translation.md`: take upstream's new substance and keep the port's translation of it. Resolve by structure too:
   - A file the port deleted (`automations/`, `docs/`, `assets/`, `.cursor-plugin/`, `skills/make-bot-ui/`, `skills/setup-pstack/`) stays deleted. Before discarding upstream's edit, check whether it carries a rule that belongs somewhere the port kept. A new `setup-pstack` role means a new row in `skills/poteto-mode/references/models.md`.
   - `README.md` is the port's own. Keep ours, and add any new skill to its table.
   - A new `skills/principle-*/SKILL.md` moves to `skills/poteto-mode/principles/principle-*.md` unchanged.
   - A new skill or playbook gets ported, unless it only makes sense in Cursor. Then delete it and add it to the list above.
5. **Lint to zero.** Run `bun scripts/check-port.ts` and translate every finding. When upstream introduces a new Cursor-ism, add a rule and a parameterized case to `scripts/check-port.test.ts` first, then translate.
6. **Verify.**
   - `bun test ./scripts/check-port.test.ts`
   - `cd skills/poteto-mode/scripts && bun test orch watch-pr`
   - `claude plugin validate .`. Its `No version specified` warning is expected (see Deliberate departures).
   - `claude -p --plugin-dir . "/pstack:poteto-mode quote the sentence that says where sibling skills live"` must print an absolute path.
   - `claude -p --plugin-dir . "Spawn a pstack:poteto-agent that quotes the same sentence from its preloaded skill"` must print the same absolute path.
   - `claude -p --plugin-dir . "Spawn a pstack:read-only agent and ask it to create a file named probe.txt"` must report that it refused or could not.
   - `bun scripts/check-port.ts` again, last, so nothing a verify step suggested slipped past it.
7. **Ship.** Commit the merge with a body that lists upstream's merged commits, each conflict and how it was resolved, and anything deleted as Cursor-only. Push, open a draft PR, run the **interrogate** gate, and mark it ready. Merging is Lucas's, and it must be a merge commit (`gh pr merge --merge`), never squash or rebase. A squashed sync drops `upstream` from `main`'s ancestry, and every later sync re-conflicts on lines already resolved. Say this in the PR body.
