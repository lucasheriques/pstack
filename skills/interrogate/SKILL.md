---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", \"tear this apart\", reviewing someone else's PR, and as the pre-PR gate before opening or readying a PR. Multiple LLM reviewers challenge changes from independent angles."
---

# Interrogate

Spawn one reviewer per configured model to adversarially review code changes. The adversarial signal comes from model diversity, not assigned personas.

The deliverable is a synthesized verdict. Do NOT auto-apply changes. When a poteto-mode playbook runs this skill as its pre-PR gate, hand the verdict back to it instead of ending the turn. The gate's rules are Opening a PR step 2.

## Step 1, Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that.
- If on a feature branch, run `git diff main...HEAD` (or the appropriate base branch) for the full changeset.
- If given a PR number or URL, use `gh pr view <pr> --json title,body,baseRefName,headRefOid,files` and `gh pr diff <pr>`.
- If the user's message references recent work, gather the relevant files.

Package the diff or file contents with any surrounding context files the reviewers need to understand the code.

## Step 2, Intent

Before spawning reviewers, state the intent in one clear paragraph from the user's message, commit messages, the PR description if one exists, and the code. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn Reviewers

Launch all reviewers in a single message with the Agent tool, one per entry in the `interrogate reviewers` list of `${CLAUDE_SKILL_DIR}/../poteto-mode/references/models.md`, labeled Reviewer A, B, and so on. Each reviewer gets `subagent_type: "pstack:read-only"` and `model` set to its entry.

Read `${CLAUDE_SKILL_DIR}/references/reviewer-prompt.md` and fill in the same template for every reviewer with the stated intent, the diff or file contents, the rubric from `${CLAUDE_SKILL_DIR}/references/rubric.md`, the code-quality lens from `${CLAUDE_SKILL_DIR}/references/code-quality-review.md`, and the blind-spot lenses from `${CLAUDE_SKILL_DIR}/references/blind-spots.md` that the diff calls for, or "none".

## Step 4, Synthesize

As results come back, build a unified picture. Parse every reviewer's findings. Merge findings that describe the same issue differently, and note which models raised each one. Findings two or more models raised independently are the highest signal. Read a lone model's finding, but weight it accordingly. Note disagreements. If one model flags something and another explicitly says the opposite, that is context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator. Read `${CLAUDE_SKILL_DIR}/references/lead-judgment.md` for the full framework. Before you place a finding in **Act on** or **Consider**, check it against the source yourself: read the cited lines, trace the call site, and run the cheapest repro. A finding you cannot reproduce from source goes to **Dismissed** with the reason. Put every finding in one of four buckets, with the model(s) that raised it and a one-line rationale.

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. They would block a real PR.
- **Consider**. Legitimate, but you're not sure they outweigh the cost of addressing them now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact at this stage.
- **Dismissed**. Wrong, nitpicky, or missing context, with a brief reason.

## Output Format

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer [label]: [model name], [N findings] (one bullet per reviewer)

### Act On
[Each: description, which models raised it, why it matters.]

### Consider
[Each: description, which models raised it, the tradeoff.]

### Noted
[Brief list.]

### Dismissed
[Each with a brief rationale.]

### Agreement Map
[Where models agreed and diverged, and what that pattern tells us.]

## Someone else's PR

When the PR belongs to another author, the verdict becomes review comments that person will read. Turn **Act on** and **Consider** findings into comments per `${CLAUDE_SKILL_DIR}/references/review-comments.md`, run them through the **unslop** skill (`${CLAUDE_SKILL_DIR}/../unslop/SKILL.md`), and show the full draft to the user. Post nothing until the user explicitly says to.
