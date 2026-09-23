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
  ])("allows %s", (_, path, line) => {
    expect(findingsFor(path, line)).toEqual([]);
  });
});
