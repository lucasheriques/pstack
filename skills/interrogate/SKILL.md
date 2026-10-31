---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", \"tear this apart\", reviewing someone else's PR, and as the pre-PR gate before opening or readying a PR. Adversaries try to break a change or design, and only findings proven by a run survive."
---

# Interrogate

Adversaries try to break a change or a design. A finding survives only when a run proves it. Report the findings. Do not apply fixes. When a poteto-mode playbook runs this skill as its pre-PR gate, hand the findings back to it instead of ending the turn. The gate's rules are Opening a PR step 2.

## Frame

The scope is what the user names. Given a PR number or URL, it is that PR: read it with `gh pr view <pr> --json title,body,baseRefName,headRefOid,files` and `gh pr diff <pr>`. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent with the **in-your-own-words** skill (`${CLAUDE_SKILL_DIR}/../in-your-own-words/SKILL.md`), from the user's message, the commits, and the PR description. Ask the user when the intent is unclear.

Pick the blind-spot lenses from `${CLAUDE_SKILL_DIR}/references/blind-spots.md` that the change calls for, or none. Diff-scoped attacks cannot see what is missing, and the lenses cover that gap.

## Fan out

Run Phase A steps 3 and 4 and Phase B of the **arena** skill (`${CLAUDE_SKILL_DIR}/../arena/SKILL.md`), with four changes. Read the `interrogate reviewers` role in `${CLAUDE_SKILL_DIR}/../poteto-mode/references/models.md` in place of `arena runners`. Spawn each adversary with `subagent_type: "general-purpose"` and `isolation: "worktree"`, and name the commit it checks out: the PR's head SHA for a PR, otherwise the current `HEAD`. Copy the scope's uncommitted changes into each worktree. In place of the arena task and rationale, give each adversary the scope, the intent, the chosen lenses, and this brief:

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree, and never push. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

## Verify

Verify each finding per arena Phase F by rerunning its command. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause.

Skip arena Phases C, D, and E. Adversaries find different failures, so the verdict keeps every verified finding, not one adversary's list.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, and the adversaries that found it. Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.

## Someone else's PR

When the PR belongs to another author, the findings become review comments that person will read. Turn each verified finding into a comment per `${CLAUDE_SKILL_DIR}/references/review-comments.md`, run them through the **unslop** skill (`${CLAUDE_SKILL_DIR}/../unslop/SKILL.md`), and show the full draft to the user. Post nothing until the user explicitly says to.
