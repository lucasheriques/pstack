# Blind-spot Lenses

Diff-scoped review sees what a hunk gets wrong. It cannot see what is missing, because no line is wrong. These lenses cover that gap. Frame takes every lens whose "Use when" the change meets. Correctness review does not cover them on its own.

## Parity

Use when the change ports or reimplements something that already exists: another language's SDK, a spec, a sibling service. Read the reference first. For every observable the reference produces (each event, each field on it, each captured timing or error, each config option and its effect), build a row: `reference behavior | port behavior | match? | gap`. Report every row where the port captures less, captures it differently, or omits it. Walk the reference feature by feature. Do not assume the diff is complete.

## Completeness

Use when the code handles a protocol, a state machine, a lifecycle, or an input space with several paths. Before judging, enumerate the full matrix the code is responsible for: every message, state, input shape, and host environment, and their meaningful combinations. For each cell, find where it is handled. A cell with no handler is a finding even when no existing line is wrong.

## Interactions

Use when options or features can combine, or a resource has a create, use, dispose lifecycle. List the option combinations and check each one end to end, not each option alone. Follow every created, scheduled, or acquired thing (tasks, futures, files, locks, connections, subscriptions) to its await, close, or release. Flag type mismatches and paths that skip cleanup.

## Exposure

Use when the change adds or reshapes a value that leaves the process: telemetry, logs, error reports, responses, files. Trace each such value back to its source. Put a canary secret in each untrusted input that feeds it, including metadata, headers, identifiers, URLs, and error text, and run every path the change adds or alters that writes it out. Report every place the canary arrives unredacted, and every new value that skips the redaction its neighbors in the same payload pass through.

## Isolation

Use when the change touches state that outlives one request or call: instance fields, module-level caches, maps keyed by name, anything cleared and rebuilt. Interleave two callers with different identities and inputs, once on one shared instance and once on a fresh instance per request. Report any value from one caller that shows up in the other's output, any result that depends on which instance served an earlier request, and any window where a reader sees state half rebuilt.

## Upgrade

Use when the change reaches consumers outside this repo: a package other code installs, a public API, a CLI, or a tool, event, or file schema that others read. Act as a consumer who upgrades or keeps calling and changes nothing on their side. Run their setup with default options before and after the change, and diff everything they can observe: payloads, schemas, return values and their identity, the arguments that reach their own handlers, thrown errors. Hold the change to every promise the docs make, such as "never throws" or "leaves your input unchanged". Report each difference the changelog does not name, and each one that breaks the compatibility promise it ships under, such as its version bump.
