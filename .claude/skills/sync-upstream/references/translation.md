# Cursor to Claude Code translation

The standing rules for porting upstream pstack text. `bun scripts/check-port.ts` flags every line that still needs one of these. Translate meaning, not tokens. When a sentence only exists to work around a Cursor harness quirk, delete it.

## Harness

| Upstream (Cursor) | Port (Claude Code) |
|---|---|
| `Task` tool, Task call | the Agent tool |
| `subagent_type: "generalPurpose"` | `subagent_type: "general-purpose"` |
| `readonly: true` on a Task | `subagent_type: "pstack:read-only"` (Edit, Write, NotebookEdit disallowed; MCP tools still available) |
| `poteto-agent` | `subagent_type: "pstack:poteto-agent"` |
| `Comment Sicko` | `subagent_type: "pstack:comment-sicko"` |
| `run_in_background: true` | same parameter, and the default |
| `AskQuestion` | `AskUserQuestion` |
| `is_background: true` (agent frontmatter) | `background: true` |
| `mode: true`, `reminder:`, `icon:`, `color:` (skill frontmatter) | delete. poteto-mode is model-invocable instead of sticky |
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

- **Draft first.** Open a PR as a draft as soon as it is coherent enough to read. Mark it ready only after it is verified and the pre-PR gate is clean. Marking ready is the agent's call. Merging and deploying are the user's, so a playbook that merges runs only on an explicit instruction to land or merge.
- **Pre-PR gate.** Before marking a PR ready, run `interrogate` on the branch against the trunk. Fix or explicitly dismiss every finding and report what was found, fixed, and dismissed.
- **Stacks use `gh stack`.** `gh stack init`, `add`, `submit` (drafts by default), `sync`, `rebase`. Raw `git rebase` or force-push on a stacked branch breaks GitHub's stack tracking. Fall back to raw git only when `gh stack` has no equivalent.
- **Commit messages.** Title is one high-level line of what shipped (Conventional Commits form is fine). Body is what we did, why, and how it was tested (commands and results), plus reviewer notes when a decision or gap is worth flagging. Compact: the diff carries the details.
- **Comments.** Never remove a comment that existed before this change. Comment cleanup (`no-comments`, `comment-sicko`) touches only comments this change added.
- **Delegation.** The main loop is the architect and reviews every delegated commit. `sonnet` is the default doer, `opus` when hard (say so), never `haiku`. Always tell the user what was delegated and to whom. The architect runs the proof itself and does not hand verification of its own work to a subagent. Review panels (`interrogate`, `arena` judges) are separate reviewers, not self-verification.
- **Chat output.** No ligature characters: write `->`, `!=`, `>=`. Never estimate time. Estimate by complexity.
