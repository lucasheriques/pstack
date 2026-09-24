import { describe, expect, test } from "bun:test";
import { findingsFor } from "./check-port";

describe("findingsFor", () => {
  test.each([
    ["skills/x/SKILL.md", "Write `~/.cursor/rules/pstack-models.mdc`.", "cursor-path"],
    ["skills/x/SKILL.md", "Cursor's built-in plan mode.", "cursor-brand"],
    ["skills/x/SKILL.md", "Run `/deslop` from `cursor-team-kit`.", "cursor-team-kit"],
    ["skills/x/SKILL.md", "Drive it with `control-ui`.", "cursor-team-kit"],
    ["skills/x/SKILL.md", "Prefer AskQuestion over free text.", "cursor-tool"],
    ["skills/x/SKILL.md", "Launch reviewers with the Task tool.", "cursor-tool"],
    ["skills/x/SKILL.md", "- `subagent_type`: `generalPurpose`", "cursor-tool"],
    ["skills/x/SKILL.md", "- `readonly`: `true`", "cursor-tool"],
    ["skills/x/SKILL.md", "Default `grok-4.7-xhigh-fast` for code.", "non-claude-model"],
    ["skills/x/SKILL.md", "Reviewer B | `gpt-5.6-sol-max` |", "non-claude-model"],
    ["skills/x/SKILL.md", "Hand it to codex exec.", "non-claude-model"],
    ["skills/x/SKILL.md", "Model `claude-opus-5-5-max`.", "cursor-model-slug"],
    ["skills/x/SKILL.md", "Use `origin pr merge <pr>`.", "origin-forge"],
    ["skills/x/SKILL.md", "Each a cloud agent.", "cursor-cloud-agent"],
    ["skills/x/SKILL.md", "mode: true", "cursor-frontmatter"],
    ["skills/x/SKILL.md", "Follow the **create-skill** skill.", "cursor-builtin-skill"],
    ["skills/x/SKILL.md", "Triage the Bugbot comments.", "cursor-bugbot"],
    ["skills/x/SKILL.md", "Read **principle-made-up-name**.", "unresolved-principle"],
    ["skills/swarm/SKILL.md", 'Spawn with `environment: "cloud"`.', "cursor-tool"],
    ["skills/swarm/SKILL.md", "Set `cloud_base_branch` on the worker.", "cursor-tool"],
    ["skills/reflect/SKILL.md", "Grep the Shell tool calls.", "cursor-tool"],
    ["skills/how/SKILL.md", "Read `${CLAUDE_SKILL_DIR}/references/missing.md`.", "unresolved-skill-path"],
    ["skills/how/SKILL.md", "Read `${CLAUDE_SKILL_DIR}/../nope/SKILL.md`.", "unresolved-skill-path"],
    ["skills/x/SKILL.md", 'Spawn `subagent_type: "pstack:no-such-agent"`.', "unresolved-pstack-name"],
    [".claude-plugin/plugin.json", '  "version": "0.15.4",', "plugin-version"],
    [".claude-plugin/marketplace.json", '      "version": "1.0.0",', "plugin-version"],
  ])("%s flags %p as %s", (path, line, rule) => {
    expect(findingsFor(path, line).map((f) => f.rule)).toContain(rule);
  });

  test.each([
    ["TypeScript readonly modifier", "skills/typescript-best-practices/SKILL.md", "Mark it `readonly`."],
    ["git remote named origin", "skills/x/SKILL.md", "git fetch origin && git reset --hard origin/main"],
    ["Claude Code tools", "skills/x/SKILL.md", "Use AskUserQuestion, then the Agent tool."],
    ["bugbot reference file path", "skills/x/SKILL.md", "Triage per `references/bugbot-triage.md`."],
    ["resolvable principle", "skills/x/SKILL.md", "Read **principle-laziness-protocol**."],
    ["the port's own README", "README.md", "Ported from Cursor's pstack."],
    ["an existing skill-relative path", "skills/how/SKILL.md", "Read `${CLAUDE_SKILL_DIR}/references/explorer-prompt.md`."],
    ["a sibling skill path", "skills/teach/SKILL.md", "Read `${CLAUDE_SKILL_DIR}/../how/SKILL.md`."],
    ["a placeholder path", "skills/poteto-mode/SKILL.md", "Siblings live at `${CLAUDE_SKILL_DIR}/../<name>/SKILL.md`."],
    ["a pstack agent", "skills/x/SKILL.md", 'Use `subagent_type: "pstack:read-only"`.'],
    ["a pstack skill", "README.md", "Run /pstack:poteto-mode."],
    ["a pstack skill in prose", "skills/x/SKILL.md", "Route through `pstack:poteto-mode`."],
    ["a version field elsewhere", "skills/poteto-mode/scripts/package.json", '  "version": "1.0.0",'],
  ])("allows %s", (_, path, line) => {
    expect(findingsFor(path, line)).toEqual([]);
  });
});
