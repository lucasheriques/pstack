# pstack port

- `.claude-plugin/plugin.json` has no `version` on purpose. Claude Code then versions installs by commit SHA, so every merge to `main` reaches `claude plugin update`. A version string that doesn't change blocks updates. `bun scripts/check-port.ts` fails if one comes back.
- Porting rules and deliberate departures from upstream live in `.claude/skills/sync-upstream/references/translation.md`. Run `bun scripts/check-port.ts` before every commit.
