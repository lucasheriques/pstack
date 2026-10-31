# Cursor to Claude Code translation

The standing rules for porting upstream pstack text. `bun scripts/check-port.ts` flags every line that still needs one of these. Translate meaning, not tokens. When a sentence only exists to work around a Cursor harness quirk, delete it.

## Harness

| Upstream (Cursor) | Port (Claude Code) |
|---|---|
| `Task` tool, Task call | the Agent tool |
| `subagent_type: "generalPurpose"` | `subagent_type: "general-purpose"` |
| `readonly: true` on a Task | `subagent_type: "pstack:read-only"` (Edit, Write, NotebookEdit disallowed; MCP tools still available). Weaker than Cursor's flag: Bash stays available because investigators need `git` and `gh`, so read-only on the shell is enforced by the agent's prompt, not the harness |
| `poteto-agent` | `subagent_type: "pstack:poteto-agent"` |
| `Comment Sicko` | `subagent_type: "pstack:comment-sicko"` |
| `run_in_background: true` | same parameter, and the default |
| `AskQuestion` | `AskUserQuestion` |
| `is_background: true` (agent frontmatter) | `background: true` |
| `mode: true`, `reminder:`, `icon:`, `color:` (skill frontmatter) | delete. poteto-mode is model-invocable instead of sticky |
| agent `name:` with spaces or capitals | kebab-case. The `subagent_type` is `pstack:<name>` |
| one skill routing to another ("the **how** skill") | keep upstream's `disable-model-invocation: true`, which hides a skill from the Skill tool entirely, and have the caller read `${CLAUDE_SKILL_DIR}/../<name>/SKILL.md`. poteto-mode states this once for its playbooks |
| Cursor plan mode | Claude Code plan mode |
| Cursor cloud agent | a background subagent with `isolation: "worktree"`, or `isolation: "remote"` when it must outlive the session |
| Cursor restart | Claude Code restart or context compaction |
| `/loop` | unchanged. Claude Code ships `/loop` (dynamic mode when no interval is given) |
| Cursor's built-in `/babysit` | delete the reference |
| a parent-supplied path to `poteto-mode/SKILL.md`, or a search of `~/.cursor/plugins/` for it | delete. `pstack:poteto-agent` preloads the skill, and poteto-mode names its siblings by absolute path |
| a built-in PR tool for create, edit, retarget, and ready | delete. `gh` covers every PR operation |

## Models

Upstream slugs (`claude-opus-5-5-max`, `gpt-5.6-sol-max`, `grok-4.7-xhigh-fast`, composer, codex) become role lookups in `skills/poteto-mode/references/models.md`. Write "the `<role>` model from poteto-mode's `references/models.md`" rather than a model name. Aliases `inherit-parent` and `auto` become "omit `model`". Delete every paragraph about slugs that fail to resolve, budget tiers, or `~/.cursor/rules/pstack-models.mdc`. The Agent tool has no reasoning-level or speed setting, so delete "pick each subagent's reasoning level and fast or standard speed". poteto-mode's "Match the model to the job" keeps only what the model dial can express: escalate to the hardest-tasks model, keep verification on `swarm workers`, keep panels as listed. Claude Code's `model` parameter accepts `opus`, `sonnet`, or nothing here. Never `haiku` or `fable`. No non-Claude models.

## Paths

| Upstream | Port |
|---|---|
| `~/.cursor/skills/`, `.cursor/skills/` | `~/.claude/skills/`, `.claude/skills/` |
| `.cursor/rules/*.mdc` | the project's `CLAUDE.md` |
| `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` | `~/.claude/projects/<slug>/<session-id>.jsonl`, where `<slug>` is the absolute working directory with every non-alphanumeric character replaced by `-`. Subagent transcripts are `~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.jsonl`. A skill gets its own session id as `${CLAUDE_SESSION_ID}` |
| a principle skill `principle-<name>`, "the **<name>** principle skill", or "the **principle-<name>** skill" | `skills/poteto-mode/principles/principle-<name>.md`. Write the `**principle-<name>**` token in prose; the lint resolves it |
| the agent store ("path in the system prompt") | a path the root names in the brief |

## Companion tools

| Upstream | Port |
|---|---|
| `/deslop` (cursor-team-kit) | the built-in `/simplify` skill |
| `control-ui` (browser, Electron, web) | the `claude-in-chrome` browser tools, or the built-in `run` skill for Electron |
| `control-cli` (CLIs, TUIs) | the built-in `run` skill |
| iOS surfaces | the iOS Simulator tool |
| `create-skill` (Cursor built-in) | the `skill-creator` skill |
| `/visualize` (Cursor built-in) | the session's visual tool: an inline widget or an Artifact, when the session has one |
| Origin (`origin pr ...`, `--forge origin`) | delete. `gh` is the only forge, in prose and in scripts (`worktree-audit.sh`) |
| a stack as a base-branch chain changed with `gh pr edit --base` | `gh stack` (`link`, `sync`, `rebase`, `push`). GitHub restacks the rest server-side after a bottom PR merges, so upstream's post-merge retarget goes away |
| Bugbot, Cursor's agentic security review | "review bots" (Bugbot, Copilot, Greptile, CodeRabbit, and similar). The file keeps its name `references/bugbot-triage.md` |
| `setup-pstack` | edit `skills/poteto-mode/references/models.md` |

## Lucas's house rules

These override upstream wherever they conflict.

- **Ready after the gate.** A draft is fine while work is in progress. The gate is Opening a PR step 2, and every playbook points there. Once it is clean, the agent opens or readies the PR itself, in the same turn, and never hands that back to the user. Agents merge only through `scripts/merge-gate` under `~/.claude/pstack/merge-policy.json`. Any other merge needs an explicit instruction to land or merge, and deploys outside a merge are the user's.
- **Stacks use `gh stack`.** `gh stack init`, `add`, `submit --auto`, `sync`, `rebase`. Raw `git rebase` or force-push on a stacked branch breaks GitHub's stack tracking. Fall back to raw git only when `gh stack` has no equivalent.
- **Commit messages.** Title is one high-level line of what shipped (Conventional Commits form is fine). Body is what we did, why, and how it was tested (commands and results), plus reviewer notes when a decision or gap is worth flagging. Compact: the diff carries the details.
- **Comments.** Never remove a comment that existed before this change. Comment cleanup (`no-comments`, `comment-sicko`) touches only comments this change added.
- **Delegation.** The main loop is the architect and reviews every delegated commit. `sonnet` is the default doer, `opus` when hard (say so), never `haiku`. Always tell the user what was delegated and to whom. The architect runs the proof itself and does not hand verification of its own work to a subagent. Review panels (`interrogate`, `arena` judges) are separate reviewers, not self-verification.
- **Chat output.** No ligature characters: write `->`, `!=`, `>=`. Never estimate time. Estimate by complexity.

## Deliberate departures

A sync must keep these even when upstream's line differs.

- `interrogate`, `typescript-best-practices`, and `poteto-mode` drop `disable-model-invocation`. interrogate is the pre-PR gate CLAUDE.md names, typescript-best-practices needs its `paths:` trigger, and poteto-mode is the auto-invoked entry point. Every other skill keeps the flag.
- poteto-mode's Autonomy pauses for anything sent as the user (team chat, comments on other people's PRs) and for merges. Upstream let team chat proceed.
- automate-me writes the mode skill to `~/.claude/skills/<handle>-mode/` instead of a project skill shipped by PR.
- Autopilot-full needs an explicit merge grant. Babysit and Shipping never merge without an explicit request.
- orchestrate and swarm isolation: remote by default for orchestrate workers, and a worktree for any swarm worker that checks out, builds, or runs.
- Orchestrate keeps its state in `~/.claude/projects/<slug>/pstack/orchestrate/<project-slug>/notes.md`, where upstream uses Cursor's Project tracker and store. Owners stack with `gh stack` and merge through `merge-gate`.
- Arena's cross-judge is the first `arena cross-judge pool` entry whose model differs from the parent's. Upstream picks by model family, and the port's pool is all Claude, so a family rule would always skip the judge. Opus and sonnet count as different judges.
- `.claude-plugin/plugin.json` carries no `version`, where upstream's `.cursor-plugin/plugin.json` does. Claude Code then versions a GitHub-hosted install by commit SHA, so every merge to `main` reaches `claude plugin update`. A version string that does not change blocks updates. The `plugin-version` rule in `scripts/check-port.ts` keeps it out. `claude plugin validate` warns about the missing version. That warning is expected.
- interrogate adds the blind-spot lenses (`references/blind-spots.md`, chosen in Frame and passed to every adversary), a PR number or URL as scope with each adversary's worktree on the PR head, and the someone-else's-PR flow (`references/review-comments.md`), all folded in from Lucas's retired pr-review-swarm skill. When a playbook runs it as the pre-PR gate, it hands the findings back instead of ending the turn. The gate's rules live in Opening a PR step 2, which applies every verified finding or treats it as a blocker. Upstream dropped interrogate from opening a PR. The port keeps it as the gate. It runs no tool-based analyzers: a CodeScene change-set step was tried and removed after an eval showed the reviewers already covered everything it found (PR #2).
- `skills/poteto-mode/scripts/merge-gate/` is port-only. It reuses watch-pr's readiness verdict without editing watch-pr, and adds the policy: allowed repos, human-only paths needing a human approval on the head, and head pinning with `--match-head-commit`. A PR in a GitHub native stack refuses `gh pr merge`, so the gate falls back to the merge-async REST endpoint with the same head SHA. `--stack` gates native stack positions 1 to the target as one unit: each open PR runs the same per-PR decision, with its expected base being the head of the open PR below it instead of trunk, and one merge-async call on the target, pinned to its head, lands the range atomically. merge-async pins only that head, so the gate re-reads every head and the stack just before the call and refuses a merged head it did not gate (`merged-ungated-head`). Upstream has no native stacks. Every playbook merges only through it, and a refusal is final: human-only changes are the user's to merge. The policy lives outside git, and editing it is on poteto-mode's always-pause list.
- `principle-never-block-on-the-human` narrows its force-push example to "force-push to a shared branch", matching poteto-mode's Autonomy. Autopilot owners force-push their own branches with a lease on every rebase.
- models.md uses only `opus` and `sonnet`. `fable` is dropped for cost: every role that upstream maps to it, and every panel slot, goes to `opus` or `sonnet`. interrogate runs two adversaries (`opus`, `sonnet`), accepting that both share one family and give less independent review than a cross-family pair.
- Autopilot-stack owners never force-push a branch once the root links it into the `gh stack`. They only add commits, and take the root's push as their new base and lease. Moving a PR out of a stack is the user's, since `gh stack modify` is interactive.
- Shipping and Autopilot-full merge through `merge-gate`, never `gh pr merge --squash`, and never arm `--auto`, because GitHub merges at once without required checks.
- `skills/poteto-mode/scripts/check-plan.test.ts` uses the port's plan template: "Ten lanes at the PR head" with no model, and the "Re-read them at every tick" marker.
- `skills/poteto-help/` is rewritten, not ported line for line. Setup, Custom Modes, and the guide pages are replaced by `claude plugin` install and update, `models.md`, and the README's merge-policy section. Its skill map uses relative links, and the skill tells the model to give users the public GitHub URL.
