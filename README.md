# pstack for Claude Code

This is an unofficial port of [pstack](https://github.com/cursor/plugins/tree/main/pstack) to Claude Code. pstack is written and maintained by [poteto](https://x.com/poteto) for Cursor. I'm not poteto, just a fan who wanted the same workflow in Claude Code.

Everything that makes pstack good is poteto's work: the playbooks, the principles, the review panels, and the idea behind them ("if you want to go fast, go deep first"). This repo only ports it. It translates the skills from Cursor's tools, models, and paths to Claude Code's, and merges upstream changes as they land. For the original, its docs, and to credit or support the author, go to [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack).

## Install

```bash
claude plugin marketplace add lucasheriques/pstack
claude plugin install pstack@pstack
```

To update, run `claude plugin marketplace update pstack`, then `claude plugin update pstack@pstack`. The plugin has no version number on purpose, so every commit to `main` counts as a new release (see `translation.md`).

## Use

`poteto-mode` is the entry point. It switches on by itself for engineering work that matches a playbook or needs rigor, or you can call it with `/pstack:poteto-mode <task>`. It matches the task to one of its playbooks (bug fix, feature, refactoring, perf, investigation, babysit, shipping, multi-phase plan, autonomous run, and more), copies the steps into a todo list, and routes to the other skills as the steps need them.

You can also call the other skills directly:

```
/pstack:how do we cancel runs? do we have an n+1 when we look up every run to cancel?
/pstack:why is this feature flag not on yet?
/pstack:teach the new sync engine
/pstack:recall the auth migration
/pstack:interrogate review this pr
```

| skill | use it when |
|---|---|
| `how` | you want a walkthrough of how a subsystem works |
| `why` | you want to know why something was built this way, from every source your MCP tools reach |
| `teach` | you want to understand a change or subsystem, built up diagram by diagram |
| `recall` | you're resuming work and want your recent context rebuilt from past sessions |
| `bro` | you want the last message restated in plain language |
| `blast-radius` | a small-looking change might break something else |
| `architect` | code crosses a function boundary and the caller's shape should be settled first |
| `arena` | you want several parallel attempts at the same thing, then the best parts of each |
| `swarm` | you want parallel workers over different slices, then one report |
| `interrogate` | a diff needs adversarial review. It is also the pre-PR gate |
| `tdd` | a bug has a cheap local test path |
| `no-comments` | strip the comments this change added before review |
| `unslop`, `technical-writing` | prose, docs, PR descriptions, commit messages |
| `typescript-best-practices` | reading or editing TypeScript |
| `figure-it-out` | no playbook fits, so design a bespoke one |
| `show-me-your-work` | long or unattended runs that need a decision trail |
| `reflect` | a long task landed and the lesson should become a skill edit |
| `create-verification-skill`, `maintain-verification-skill` | a project needs a scripted way to prove app behavior |
| `automate-me` | you want your own `<name>-mode` skill drafted from how you work |

The 23 principles live in `skills/poteto-mode/principles/`. poteto-mode reads them on demand instead of loading them into every session.

## Differences from upstream

- **Claude models only.** Roles map to `sonnet`, `opus`, and `fable` in [`skills/poteto-mode/references/models.md`](skills/poteto-mode/references/models.md). Edit that file to change a role. It replaces `/setup-pstack`.
- **Harness.** `Task` becomes the Agent tool, `readonly` becomes the `pstack:read-only` agent, `/deslop` becomes `/simplify`, `control-ui` and `control-cli` become `claude-in-chrome` and the `run` skill, and the Origin forge is gone in favor of `gh` and `gh stack`.
- **My house rules.** A few defaults follow my own workflow instead of poteto's: draft PRs first, with `interrogate` as the gate before marking ready. Merging stays with the human. Comment cleanup never touches pre-existing comments.
- **Not shipped.** benny, make-bot-ui, setup-pstack, and the guide. They depend on Cursor.

The full mapping is in [`.claude/skills/sync-upstream/references/translation.md`](.claude/skills/sync-upstream/references/translation.md).

## Staying in sync

The `upstream` branch mirrors `cursor/plugins/pstack`, one commit per sync. `main` merges it, so each sync is a 3-way merge that keeps the port's translations and takes poteto's new substance. In this repo, ask Claude Code to "sync upstream". The project-local `sync-upstream` skill runs `scripts/sync-upstream.sh`, merges, and resolves conflicts. It then gates on `bun scripts/check-port.ts`, a lint that fails on any Cursor-ism left in the tree.

## License

MIT, as upstream. Copyright Lauren Tan. Port changes copyright Lucas Faria.
