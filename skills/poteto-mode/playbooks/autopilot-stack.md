### Autopilot-stack

Run the Autopilot-full playbook, but do not merge.

1. **In place of step 5, stop at verified.** Stop when each PR is verified and green at its current head, then hand the PRs to the operator. Owners never merge, close a PR, or arm auto-merge, because the operator owns the landing. After the handoff, nobody pushes without the operator's go. Every loop tick prompt names this file, so each tick sees the no-merge rule.
2. **Stack a PR only when it builds on another PR.** This is the one exception to step 3. Its owner branches from the other PR's branch in place of trunk, per **Size and stacks** in `playbooks/opening-a-pr.md`. You are the stack's one writer, because two writers on one chain undo each other. Link each clean PR in dependency order with `gh stack link <stack-number> <owner-branch>`, which pushes the branch, reuses its open PR, and chains its base onto the stack's top. In place of step 2's rebase onto trunk, bring the chain onto trunk bottom-up with `gh stack sync`, or `gh stack rebase` when a conflict needs hands. Once a branch is linked, its owner only adds commits, never rebases or force-pushes it, and takes your push as its new base and lease, because raw `git rebase` or a force-push on a stacked branch breaks GitHub's stack tracking. A new head on the lower PR restacks the PRs above it, and a PR whose `git patch-id` the restack leaves unchanged keeps its verdict.

**Reply:** list each PR with its verdict, in place of what merged.
