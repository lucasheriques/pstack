---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", \"tear this apart\", reviewing someone else's PR, and as the pre-PR gate before opening or readying a PR. Multiple LLM reviewers challenge changes from independent angles."
---

# Interrogate

Spawn one reviewer per configured model to adversarially review code changes. Each model gets the same prompt and rubric. The adversarial signal comes from model diversity, not assigned personas.

The deliverable is a synthesized verdict. Do NOT auto-apply changes. When a poteto-mode playbook runs this skill as its pre-PR gate, hand the verdict back to it instead of ending the turn. The gate's rules are Opening a PR step 2.

## Step 1, Determine Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that
- If on a feature branch, run `git diff main...HEAD` (or the appropriate base branch) for the full changeset
- If given a PR number or URL, use `gh pr view <pr> --json title,body,baseRefName,headRefOid,files` and `gh pr diff <pr>`
- If the user's message references recent work, gather the relevant files

Package the diff (or file contents) plus any surrounding context files the reviewers need to understand the code.

## Step 2, State the Intent

Before spawning reviewers, state the intent explicitly. Derive this from:

- The user's message
- Commit messages
- PR description if one exists
- The code itself

Write one clear paragraph. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn Reviewers

Launch all reviewers in a single message using the Agent tool, one reviewer per entry in the `interrogate reviewers` list of `${CLAUDE_SKILL_DIR}/../poteto-mode/references/models.md`, labeled Reviewer A, B, and so on.

For each reviewer:
- `subagent_type`: `pstack:read-only`
- `model`: that entry

Read `${CLAUDE_SKILL_DIR}/references/reviewer-prompt.md` and fill in the template with:
1. The stated intent
2. The diff or file contents
3. The review rubric from `${CLAUDE_SKILL_DIR}/references/rubric.md`
4. The code-quality lens from `${CLAUDE_SKILL_DIR}/references/code-quality-review.md`
5. The blind-spot lenses from `${CLAUDE_SKILL_DIR}/references/blind-spots.md` that the diff calls for, or "none"

The same filled template goes to all reviewers, so every model applies the code-quality lens.

## Step 4, Synthesize

As results come back, build a unified picture:

1. **Parse all findings** from the reviewers
2. **Identify consensus**. Findings raised by 2+ models independently are highest signal.
3. **Identify lone-model findings**. Still worth reading, but weight accordingly.
4. **Deduplicate**. Different models may describe the same issue differently. Merge these and note which models raised it.
5. **Note disagreements**. If one model flags something and another explicitly says the opposite, that's useful context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator.

Read `${CLAUDE_SKILL_DIR}/references/lead-judgment.md` for the full framework. Before you place a finding in **Act on** or **Consider**, check it against the source yourself: read the cited lines, trace the call site, and run the cheapest repro. A finding you cannot reproduce from source goes to **Dismissed** with the reason.

Categorize every finding using these buckets:

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. These would block a real PR.
- **Consider**. Legitimate points, but you're not sure they outweigh the cost of addressing them right now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact given the current stage.
- **Dismissed**. Wrong, nitpicky, or missing context. Brief explanation why.

For each finding, include:
- Which model(s) raised it
- The category (act on / consider / noted / dismissed)
- A one-line rationale for the categorization

## Output Format

Present the verdict in this structure:

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer [label]: [model name], [N findings] (one bullet per reviewer)

### Act On
[Findings that should be addressed. For each: description, which models raised it, why it matters.]

### Consider
[Findings worth thinking about. For each: description, which models raised it, tradeoff involved.]

### Noted
[Valid but low-priority. Brief list.]

### Dismissed
[Rejected findings with brief rationale.]

### Agreement Map
[Where did models agree, where did they diverge, and what does the pattern of agreement/disagreement tell us?]

## Someone else's PR

When the PR belongs to another author, the verdict becomes review comments that person will read. Turn **Act on** and **Consider** findings into comments per `${CLAUDE_SKILL_DIR}/references/review-comments.md`, run them through the **unslop** skill (`${CLAUDE_SKILL_DIR}/../unslop/SKILL.md`), and show the full draft to the user. Post nothing until the user explicitly says to.
