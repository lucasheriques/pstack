# Blind-spot Lenses

Diff-scoped review sees what a hunk gets wrong. It cannot see what is missing, because no line is wrong. These lenses cover that gap. The lead picks the ones the change calls for. Correctness review does not cover them on its own.

## Parity

Use when the change ports or reimplements something that already exists: another language's SDK, a spec, a sibling service. Read the reference first. For every observable the reference produces (each event, each field on it, each captured timing or error, each config option and its effect), build a row: `reference behavior | port behavior | match? | gap`. Report every row where the port captures less, captures it differently, or omits it. Walk the reference feature by feature. Do not assume the diff is complete.

## Completeness

Use when the code handles a protocol, a state machine, a lifecycle, or an input space with several paths. Before judging, enumerate the full matrix the code is responsible for: every message, state, input shape, and host environment, and their meaningful combinations. For each cell, find where it is handled. A cell with no handler is a finding even when no existing line is wrong.

## Interactions

Use when options or features can combine, or a resource has a create, use, dispose lifecycle. List the option combinations and check each one end to end, not each option alone. Follow every created, scheduled, or acquired thing (tasks, futures, files, locks, connections, subscriptions) to its await, close, or release. Flag type mismatches and paths that skip cleanup.
