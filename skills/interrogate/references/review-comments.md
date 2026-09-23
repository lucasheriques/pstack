# Review Comments for Another Author

Comments on someone else's PR are read by a person. A false positive wastes their time, and a harsh one costs trust.

## Each comment

1. **Verified only.** Post only findings you checked against the source. When unsure, ask a question instead of asserting a defect.
2. **Specific and actionable.** Name the exact thing, why it matters, and a concrete suggestion or real question. "This returns `None` on timeout but the caller treats it as success (line N). Raise, or return a sentinel?" beats "this is confusing".
3. **One point.** No restating the diff, no preamble. If it needs three paragraphs, it is a design conversation, not a line comment.
4. **About the code, not the person.** Write "this" or "the function", never "you forgot". Assume the author had reasons. "Is X intentional? If so, a comment would help" beats "X is wrong".
5. **Grounded, not taste.** Tie each design comment to a bug, a maintenance cost, or a named principle. Skip anything the formatter or linter owns.
6. **Honest.** Don't soften a blocker into a nit, and don't inflate a nit into a blocker.

## Classify

Prefix every comment so the author can triage:

- `blocking:` must change before merge (Act on: a bug, security, data loss, a broken contract).
- `question:` the author may have context you lack (most Consider findings and most design findings).
- `nit:` optional. Group nits so they don't read as a takedown.
- `praise:` genuinely good work worth keeping.

## Shape

Open with one short paragraph: what the PR does well, then the verdict (approve, approve with nits, needs changes). Then the few blocking items as inline comments anchored to lines. Then questions and grouped nits. Leave judgment calls to the author.

## Posting

Only after the user explicitly says to post:

- Summary: `gh pr review <pr> --comment --body "<summary>"`. Use `--approve` or `--request-changes` only when the user asks for that verdict.
- Inline comments: one review through `gh api repos/{owner}/{repo}/pulls/{n}/reviews` with a `comments[]` array (`path`, `line`, `side`, `body`) at the head SHA.

Prefer a handful of high-value inline comments and one short summary over many scattered notes. If the user wants the review for themselves, output Markdown and post nothing.
