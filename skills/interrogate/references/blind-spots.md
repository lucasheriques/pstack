# Blind-spot Lenses

Diff-scoped review sees what a hunk gets wrong. It cannot see what is missing, because no line is wrong. These lenses cover that gap. Frame takes every lens whose "Use when" the change meets. Correctness review does not cover them on its own.

## Parity

Use when the change ports or reimplements something that already exists, such as another language's SDK or a sibling service, or implements behavior a spec or contract defines. Read the reference first, including the requirements a spec states for every value of a kind ("every captured string"), not only the ones the change names. For every observable the reference produces (each event, each field on it, each captured timing or error, each config option and its effect), build a row: `reference behavior | port behavior | match? | gap`. Report every row where the port captures less, captures it differently, or omits it. Walk the reference feature by feature. Do not assume the diff is complete.

## Completeness

Use when the code handles a protocol, a state machine, a lifecycle, or an input space with several paths. Before judging, enumerate the full matrix the code is responsible for: every message, state, input shape, and host environment, and their meaningful combinations. Take the environments from what the project declares it supports (dependency ranges, engine fields, the CI matrix), not from what is installed, and run the oldest and newest supported version of each peer the change calls into. For each cell, find where it is handled. A cell with no handler is a finding even when no existing line is wrong.

## Interactions

Use when options or features can combine, or a resource has a create, use, dispose lifecycle. List the option combinations and check each one end to end, not each option alone. Follow every created, scheduled, or acquired thing (tasks, futures, files, locks, connections, subscriptions) to its await, close, or release. Flag type mismatches and paths that skip cleanup.

## Exposure

Use when the change adds or reshapes a value that leaves the process: telemetry, logs, error reports, responses, files. Trace each such value back to its source. Put a canary secret in each untrusted input that feeds it, including metadata, headers, identifiers, URLs, and error text, and in anything else it copies, such as source lines, local variables, and environment. Write each canary in every shape the redaction contract names, such as a token, a URL with user info, and a JSON member. Run every path the change adds or alters that writes it out. Judge the output against the contract (a spec, a privacy requirement), not against what existing paths send: an older path that leaks the same way does not make the new one pass. Report that older path apart from the findings, as a follow-up that does not block this change. Report every place the canary arrives unredacted, and every new value that skips the redaction its neighbors in the same payload pass through.

## Isolation

Use when the change touches state that outlives one request or call: instance fields, module-level caches, maps keyed by name, anything cleared and rebuilt. Interleave two callers with different identities and inputs, once on one shared instance and once on a fresh instance per request. Report any value from one caller that shows up in the other's output, any result that depends on which instance served an earlier request, and any window where a reader sees state half rebuilt.

## Upgrade

Use when the change reaches consumers outside this repo: a package other code installs, a public API, a CLI, or a tool, event, or file schema that others read. Act as a consumer who upgrades or keeps calling and changes nothing on their side. Run their setup with default options before and after the change, and diff everything they can observe: payloads, schemas, return values and their identity, the arguments that reach their own handlers, thrown errors. Hold the change to every promise the docs make, such as "never throws" or "leaves your input unchanged". Report each difference the changelog does not name, and each one that breaks the compatibility promise it ships under, such as its version bump.

## Cost

Use when a request or event path runs work whose size an outside caller controls: a regex, parser, scanner, recursion, serialization, sort, or loop over input. For each, build hostile shapes: long runs of each character the code branches on and of each escape sequence it honors (such as `\"` repeated), near matches that fail at the end, unterminated and deeply nested structures. Start each shape small (about 1,000 characters, or 20 repeats for a near-match regex probe) and grow it fourfold per run, with a timeout of a few seconds on each, up to about 1,000,000. Stop a shape at its first timeout. Report any that grows faster than linear or times out. A regex on a backtracking engine (Python `re`, JavaScript, PCRE) gets a near-match probe for every quantified group, because the linear engines a port is often copied from (RE2, Rust `regex`) hide the blowup. Then follow what stays reachable once the call returns. An exception, traceback, or request payload that a task, context, cache, or closure keeps alive holds memory for that holder's lifetime. Report each one with what keeps it alive.
