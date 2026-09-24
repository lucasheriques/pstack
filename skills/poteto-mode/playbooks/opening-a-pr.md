### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main. Subagents inherit it. Multiple Agent calls on the same branch each get their own worktree (`isolation: "worktree"`), or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable. A commit message is a map, not the details: a one-line title of what shipped, then a body with what changed, why, and how it was tested (commands and results), plus reviewer notes when a decision or gap is worth flagging. Never `--no-verify`. Fix what the hooks catch.

**PRs.** Run `/simplify` over the diff before commit. Run `/no-comments` before review. Write every PR title, PR description, and commit body with `/technical-writing`, then apply `/unslop`. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.

**Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. Use the changed area, such as `pstack` or `poteto-mode`, as the scope. Keep the subject short and imperative. Name a real symbol when one carries the change. For example, `fix(pstack): retarget opening-a-pr babysit trigger`. Do not add a trailing period.

**Descriptions.** The PR body is a briefing, not the lab notebook. A reviewer who has the diff should learn why the change exists, what is out of scope, and how you proved the change works. The squash commit body is the PR body. If the body would make the squash commit longer than about 40 lines, cut the body.

Use these sections in order. Drop a section when it has nothing to say.

- `## Why`. State the intent and approach in one or two short paragraphs. Do not list SHAs or rebase genealogy. Do not add a "based on main" preamble.
- `## Scope`. Use bullets to list real symbols and paths. Name both sides of a rename or retarget. State what is in and out only when the boundary matters. Do not write a file-by-file essay.
- `## Tradeoffs`. Name only rejected alternatives that a reviewer would otherwise ask about. Skip this section when there was no real choice.
- `## Blast Radius`. In one to three sentences, name who or what the change touches and why the change is safe or risky. State the continuing cost if main stays red without the fix.
- `## Verification`. Name each real run path and its outcome. For a performance change, report one primary number with its unit in `before → after` form. Link the arena or swarm directory for the remaining evidence. Do not include sample-size methodology, swarm recitals, or metric tables.

After these sections, attach videos or screenshots when they prove a claim. Do not paste full SHAs, swarm or arena lane recitals, lever-correction essays, file-by-file checklists, or "CLEAN" verdicts. Put these details in a linked artifact. Do not use `## Summary` or `## Test plan` boilerplate. A commit body does not restate its subject.

**Forge.** GitHub CLI (`gh`) for create, edit, view, watch, and merge. Do not require Graphite (`gt`).

**Size and stacks.** Prefer five narrow PRs to one large PR. Stacks use GitHub's native stacked PRs through the `gh stack` extension: `gh stack init`, then `gh stack add` per layer, `gh stack submit --auto` to open the PRs, and `gh stack sync` or `gh stack rebase` to restack. Raw `git rebase` or force-push on a stacked branch breaks GitHub's stack tracking, so fall back to raw git only when `gh stack` has no equivalent. Branch from trunk only for independent work. Sync with trunk before substantial stack work. Merging a bottom PR restacks the rest server-side.

**Readiness.** A draft is fine while the work is in progress, and cheaper where CI runs only fast checks on drafts. A PR whose gate is clean is finished, and a finished PR is ready. Readying it is pre-authorized, so never hand it back to the user. Agents merge only through step 4's merge-gate. Deploying outside a merge is the user's. Run `gh pr view <number>` before you refer to PR status.

**Steps.** Every playbook's pre-PR gate is step 2.

1. `/simplify` over the diff, then `/no-comments`. Commit and push.
2. Gate. Run the **interrogate** skill against trunk. Apply each Act on finding that fits the PR's intent without changing a public API or deleting data. An Act on finding you won't fix here is a blocker, unless the lead re-buckets it to Consider or Dismissed with a reason. Commit the fixes after `/simplify` over them, rerun the checks they affect, and push. When a fix changed behavior beyond the lines its finding cited, run the gate once more on the new head and apply its findings the same way. Never run a third round.
3. No blockers: `gh pr create` without `--draft`, or `gh pr ready <number>` for your own draft. In a stack, ready only your own PR. `gh stack submit --auto --open` is for one agent that gated every PR in the stack, followed by `gh pr edit` for each title and body. With blockers: the PR stays or opens as a draft.
4. Merge, when this PR is the whole task rather than a layer mid-stack or mid-phase. Run the **Babysit** playbook in `drive` mode until the watcher reports `READY`, then `scripts/merge-gate/merge-gate <number> --merge`. Never run `gh pr merge` yourself. A final refusal is never overridden that way: the user merges it.
   - Final (report the reason and any listed files, and stop): `needs-human-approval`, `repo-not-allowed`, `not-author`, `changes-requested`, `base-not-trunk`, `policy-invalid`, `threads-unverified`, `reviews-unverified`, `files-incomplete`, `draft` (someone drafted it after you readied it, which means hold). A verdict with any final reason is final.
   - Back to Babysit, then re-gate: `checks-failed`, `threads-unresolved`, and `not-mergeable` when the detail says `DIRTY` or `BEHIND` (rebase first).
   - Transient (wait for the watcher, rerun once, then report): `checks-pending`, `head-moved`, `github-error`, and any other `not-mergeable`.
   - `merge-unverified`: run `gh pr view <number> --json state,mergeCommit`. If it merged, continue with the post-merge watch on that commit. If not, treat it as transient.
   - Any other code: report the verdict and stop.
   - After a merge, read the merge commit from the verdict, or from `gh pr view` when the verdict's is null. Wait for trunk's checks and every deploy workflow the merge commit triggers. A run that ends `cancelled` or skipped after the merge is pending, neither red nor green: it takes the result of the same workflow's first completed run on a later trunk commit that contains the merge commit and does not revert it. If that run is red, tell the user it may belong to either commit, and do not revert on it. If no such run completes, report the merge commit's status as unknown. A deploy waiting on a human approval is the user's: report it. If a run on the merge commit itself is red, tell the user at once with the failing workflow, and open a revert PR ready for the user to merge. Never merge a revert yourself: rollback is the user's call, because a red run can come from outside the change.
5. Reply with the PR URL, what the gate found, fixed, and dismissed, the Consider findings, any blocker, and the merge result or refusal.

**Babysit.** Opening a PR mid-stack or mid-phase does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass only when the user asks for one after the whole stack exists. A babysit for each new PR stalls the build and spends checks on commits that later waves restart. Push back when feedback drifts from intent.

A subagent that opens a PR runs steps 1 to 3. It returns the URL and does not babysit or merge. Return to the parent.
