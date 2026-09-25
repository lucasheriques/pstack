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

## Models

Upstream slugs (`claude-opus-5-5-max`, `gpt-5.6-sol-max`, `grok-4.7-xhigh-fast`, composer, codex) become role lookups in `skills/poteto-mode/references/models.md`. Write "the `<role>` model from poteto-mode's `references/models.md`" rather than a model name. Aliases `inherit-parent` and `auto` become "omit `model`". Delete every paragraph about slugs that fail to resolve, budget tiers, or `~/.cursor/rules/pstack-models.mdc`. Claude Code's `model` parameter only accepts `opus`, `fable`, `sonnet`, or nothing. Never `haiku`. No non-Claude models.

## Paths

| Upstream | Port |
|---|---|
| `~/.cursor/skills/`, `.cursor/skills/` | `~/.claude/skills/`, `.claude/skills/` |
| `.cursor/rules/*.mdc` | the project's `CLAUDE.md` |
| `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` | `~/.claude/projects/<slug>/<session-id>.jsonl`, where `<slug>` is the absolute working directory with every non-alphanumeric character replaced by `-`. Subagent transcripts are `~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.jsonl`. A skill gets its own session id as `${CLAUDE_SESSION_ID}` |
| a principle skill `principle-<name>` | `skills/poteto-mode/principles/principle-<name>.md`. Keep the `principle-<name>` token in prose; the lint resolves it |

## Companion tools

| Upstream | Port |
|---|---|
| `/deslop` (cursor-team-kit) | the built-in `/simplify` skill |
| `control-ui` (browser, Electron, web) | the `claude-in-chrome` browser tools, or the built-in `run` skill for Electron |
| `control-cli` (CLIs, TUIs) | the built-in `run` skill |
| iOS surfaces | the iOS Simulator tool |
| `create-skill` (Cursor built-in) | the `skill-creator` skill |
| Origin (`origin pr ...`) | delete. `gh` is the only forge |
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
- `.claude-plugin/plugin.json` carries no `version`, where upstream's `.cursor-plugin/plugin.json` does. Claude Code then versions a GitHub-hosted install by commit SHA, so every merge to `main` reaches `claude plugin update`. A version string that does not change blocks updates. The `plugin-version` rule in `scripts/check-port.ts` keeps it out. `claude plugin validate` warns about the missing version. That warning is expected.
- interrogate adds the blind-spot lenses (`references/blind-spots.md`, Step 3 item 5), a PR number or URL as scope, the lead checking each Act on and Consider finding against source, and the someone-else's-PR flow (`references/review-comments.md`), all folded in from Lucas's retired pr-review-swarm skill. When a playbook runs it as the pre-PR gate, it hands the verdict back instead of ending the turn. The gate's rules live in Opening a PR step 2. It runs no tool-based analyzers: a CodeScene change-set step was tried and removed after an eval showed the reviewers already covered everything it found (PR #2).
- `skills/poteto-mode/scripts/merge-gate/` is port-only. It reuses watch-pr's readiness verdict without editing watch-pr, and adds the policy: allowed repos, human-only paths needing a human approval on the head, and head pinning with `--match-head-commit`. Every playbook merges only through it, and a refusal is final: human-only changes are the user's to merge. Its `watch` subcommand classifies the workflows on a merge commit, including cancelled runs that inherit a later commit's result, so the post-merge rules live in tested code rather than playbook prose. The policy lives outside git, and editing it is on poteto-mode's always-pause list.
- models.md panels: interrogate runs two reviewers (`opus`, `fable`), not three. `sonnet` shares opus's family and mostly adds noise to adversarial review.
