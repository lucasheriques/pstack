# Models

Claude models only. Pass the value as the Agent tool's `model` parameter. `inherit` means omit `model`, so the role runs on the parent chat model. Never use `haiku`. Edit this file to change a role; every pstack skill reads it.

The main loop is the architect: planning, architecture, taste (UI/UX, product, strategy), hard debugging, and reviewing every piece of delegated work. Delegate only work that is large and genuinely independent. Don't delegate what you can finish in a handful of tool calls. Prefer one agent over several. Always tell the user what you delegated and to which model.

| Role | Model |
|---|---|
| feature, refactoring, bug-fix, perf-issue, hillclimb (code delegates) | `sonnet` |
| hardest tasks (cross-cutting design, gnarly concurrency, subtle algorithms, taste-sensitive work) | `opus`, and say you escalated |
| judgment and prose | `inherit` |
| how explorer | `sonnet` |
| how explainer | `inherit` |
| why investigators | `sonnet` |
| why synthesizer | `opus` |
| recall miners | `sonnet` |
| reflect tooling | `fable` |
| reflect judgment, divergent, synthesizer | `opus` |
| arena runners | `opus`, `fable`, `sonnet` |
| arena cross-judge pool | `fable`, `opus` |
| swarm workers | `sonnet` |
| architect runners | `opus`, `fable`, `sonnet` |
| interrogate reviewers | `opus`, `fable` |

Panel roles (arena runners, architect runners, interrogate reviewers) are lists. One subagent runs per entry, so the list length sets the fan-out. The arena cross-judge picks one entry whose model differs from the parent's when possible. Swarm workers use one model unless a race or comparison assigns a model per arm.

## Delegating code

Prepare the branch before delegating. A doer never commits on the trunk. Branch topology, stacking, and pushing stay with the architect.

Hand the doer a self-contained spec: the goal in one line, files in bounds, constraints, exact verify commands, and what not to touch. It commits its own work on the current branch once verification passes, lets pre-commit hooks run, and fixes what they catch. Never `--no-verify`. It never pushes or switches branches. If it cannot get hooks passing, that failure report is the deliverable and the architect takes over.

Then review the commit yourself: read `git show HEAD` against the simple-code bar and rerun the tests. Send a short fix back to the same agent with `SendMessage`, or amend directly. A scope change gets a fresh agent. Never edit files a running subagent is editing. Parallel doers get disjoint file sets and launch in one message.
