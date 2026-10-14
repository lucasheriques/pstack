---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript. It is `~/.claude/projects/<slug>/${CLAUDE_SESSION_ID}.jsonl`, where `<slug>` is the session's starting directory with every non-alphanumeric character replaced by `-`. The session id is unique, so this finds it without opening any other chat:

```bash
ls ~/.claude/projects/*/${CLAUDE_SESSION_ID}.jsonl
```

This session's subagent transcripts sit in `<slug>/${CLAUDE_SESSION_ID}/subagents/`. If no path resolves, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One message, three Agent tool calls, `subagent_type: "pstack:read-only"`. Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references, and `pstack:read-only` keeps it.

| Lens | Model from `${CLAUDE_SKILL_DIR}/../poteto-mode/references/models.md` | Prompt template |
|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `${CLAUDE_SKILL_DIR}/references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `${CLAUDE_SKILL_DIR}/references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `${CLAUDE_SKILL_DIR}/references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final report.

## 3. Synthesize

One Agent tool call, `subagent_type: "pstack:read-only"`, on the `reflect judgment, divergent, synthesizer` model. It spot-verifies citations through MCP. Pass `${CLAUDE_SKILL_DIR}/references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See **principle-encode-lessons-in-structure**.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the `skill-creator` skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
