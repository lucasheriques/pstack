import { homedir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { WatcherQueryError } from "../watch-pr/github.ts";
import type * as W from "../watch-pr/types.ts";
import { parsePrNumber } from "../watch-pr/types.ts";
import { type Reason, type ReasonCode, decide } from "./decide.ts";
import { type GateGitHub, GhGateGitHub, GhWatchGitHub, GitHubError } from "./github.ts";
import { PolicyError, loadPolicy } from "./policy.ts";
import {
  type ClassifiedVerdict,
  type Merge,
  type WatchGitHub,
  type WatchVerdict,
  type Workflow,
  type WorkflowVerdict,
  classify,
  isRevert,
  overall,
} from "./watch.ts";

interface Subject {
  readonly repo: string | null;
  readonly pr: number | null;
  readonly head: string | null;
}

export type Verdict = Subject &
  (
    | {
        readonly decision: "merge";
        readonly merged: false;
        readonly mergeCommit: null;
        readonly reasons: readonly [];
      }
    | {
        readonly decision: "merge";
        readonly merged: true;
        readonly mergeCommit: string | null;
        readonly reasons: readonly [];
      }
    | {
        readonly decision: "refuse";
        readonly merged: false;
        readonly mergeCommit: null;
        readonly reasons: W.NonEmpty<Reason>;
      }
  );

interface Request {
  readonly number: W.PrNumber;
  readonly repo: W.Repository | null;
  readonly merge: boolean;
}

export interface Runtime {
  readonly github: GateGitHub;
  readonly policyPath: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
const slug = (repo: W.Repository): string => `${repo.owner}/${repo.repo}`;

function repository(value: string): W.Repository {
  const match = REPO.exec(value);
  if (match === null) throw new InvalidArgumentError("must be owner/name");
  return { owner: match[1], repo: match[2] };
}

function target(value: string): { readonly number: W.PrNumber; readonly repo: W.Repository | null } {
  const url = PR_URL.exec(value);
  const digits = url === null ? /^#?(\d+)$/.exec(value)?.[1] : url[3];
  if (digits === undefined)
    throw new InvalidArgumentError("must be a PR number or https://github.com/owner/name/pull/N");
  try {
    return {
      number: parsePrNumber(Number(digits)),
      repo: url === null ? null : { owner: url[1], repo: url[2] },
    };
  } catch {
    throw new InvalidArgumentError("must be a positive PR number");
  }
}

function parseArgs(argv: readonly string[], runtime: Runtime): Request {
  const program = new Command("merge-gate")
    .description(
      "Decide whether an agent may merge one PR under the merge policy, and with --merge, merge it.\nPrints one JSON verdict. Exit 0: mergeable or merged, 2: refused, 1: internal error."
    )
    .configureOutput({ writeOut: runtime.stdout, writeErr: runtime.stderr })
    .exitOverride()
    .argument("<pr>", "PR number or GitHub PR URL", target)
    .option("--repo <owner/name>", "repository; defaults to the checkout's origin", repository)
    .option("--merge", "merge when the verdict is merge", false);
  program.parse(argv, { from: "user" });
  const options = program.opts<{
    readonly repo?: W.Repository;
    readonly merge: boolean;
  }>();
  const pr: ReturnType<typeof target> = program.processedArgs[0];
  if (pr.repo !== null && options.repo !== undefined && slug(pr.repo).toLowerCase() !== slug(options.repo).toLowerCase())
    program.error(`error: PR URL is in ${slug(pr.repo)} but --repo is ${slug(options.repo)}`);
  return {
    number: pr.number,
    repo: pr.repo ?? options.repo ?? null,
    merge: options.merge,
  };
}

const refuse = (subject: Subject, code: ReasonCode, detail: string): Verdict => ({
  ...subject,
  decision: "refuse",
  merged: false,
  mergeCommit: null,
  reasons: [{ code, detail }],
});

async function evaluate(request: Request, runtime: Runtime): Promise<Verdict> {
  const { github } = runtime;
  let subject: Subject = {
    repo: request.repo === null ? null : slug(request.repo),
    pr: request.number,
    head: null,
  };
  try {
    const policy = await loadPolicy(runtime.policyPath);
    const repo = request.repo ?? (await github.originRepo());
    if (repo === null)
      return refuse(subject, "invalid-arguments", "cannot infer the repository from the origin remote; pass --repo owner/name");
    subject = { ...subject, repo: slug(repo) };
    const viewer = await github.viewer();
    const facts = await github.facts({ ...repo, number: request.number });
    subject = { repo: slug(facts.pr), pr: facts.pr.number, head: facts.head };
    const decision = decide(policy, facts, viewer);
    if (decision.kind === "refuse")
      return { ...subject, decision: "refuse", merged: false, mergeCommit: null, reasons: decision.reasons };
    if (!request.merge)
      return { ...subject, decision: "merge", merged: false, mergeCommit: null, reasons: [] };
    const head = await github.head(facts.pr);
    if (head !== facts.head)
      return refuse(subject, "head-moved", `head was ${facts.head}, then ${head ?? "unknown"} before merging`);
    const merge = await github.merge(facts.pr, facts.head, decision.method);
    return merge.kind === "merged"
      ? { ...subject, decision: "merge", merged: true, mergeCommit: merge.commit, reasons: [] }
      : refuse(subject, merge.kind === "unverified" ? "merge-unverified" : "merge-failed", merge.detail);
  } catch (error) {
    if (error instanceof PolicyError) return refuse(subject, "policy-invalid", error.message);
    if (error instanceof GitHubError || error instanceof WatcherQueryError)
      return refuse(subject, "github-error", error.message);
    return refuse(subject, "internal-error", String(error));
  }
}

function exitCode(verdict: Verdict): number {
  if (verdict.decision === "merge") return 0;
  return verdict.reasons.some((reason) => reason.code === "internal-error" || reason.code === "merge-unverified") ? 1 : 2;
}

const SHA = /^[0-9a-f]{7,40}$/i;
function mergeSha(value: string): string {
  if (!SHA.test(value)) throw new InvalidArgumentError("must be a commit SHA (7-40 hex characters)");
  return value;
}
function nonNegativeNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new InvalidArgumentError(`${label} must be a non-negative number`);
  return parsed;
}

interface WatchRequest {
  readonly sha: string;
  readonly repo: W.Repository | null;
  readonly paths: readonly string[];
  readonly timeoutMinutes: number;
  readonly intervalSeconds: number;
  readonly settleSeconds: number;
}

function parseWatchArgs(argv: readonly string[], output: WatchOutput): WatchRequest {
  const program = new Command("merge-gate watch")
    .description(
      "Compute the post-merge CI/deploy state of a merge commit deterministically.\nPrints one JSON verdict. Exit 0: green, 2: any other state, 1: internal error."
    )
    .configureOutput({ writeOut: output.stdout, writeErr: output.stderr })
    .exitOverride()
    .argument("<merge-sha>", "merge commit SHA", mergeSha)
    .option("--repo <owner/name>", "repository; defaults to the checkout's origin", repository)
    .option("--paths <glob...>", "restrict to workflows whose path matches one of these globs")
    .option(
      "--timeout <minutes>",
      "minutes to wait before giving up; 0 takes a single snapshot",
      (value) => nonNegativeNumber(value, "--timeout"),
      60
    )
    .option(
      "--interval <seconds>",
      "seconds between polls",
      (value) => nonNegativeNumber(value, "--interval"),
      30
    )
    .option(
      "--settle <seconds>",
      "seconds a verdict must hold steady before it is final",
      (value) => nonNegativeNumber(value, "--settle"),
      120
    );
  program.parse(argv, { from: "user" });
  const options = program.opts<{
    readonly repo?: W.Repository;
    readonly paths?: readonly string[];
    readonly timeout: number;
    readonly interval: number;
    readonly settle: number;
  }>();
  return {
    sha: program.processedArgs[0],
    repo: options.repo ?? null,
    paths: options.paths ?? [],
    timeoutMinutes: options.timeout,
    intervalSeconds: options.interval,
    settleSeconds: options.settle,
  };
}

function matchesPaths(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => new Bun.Glob(glob).match(path));
}

const sortVerdicts = <T extends { readonly path: string; readonly workflow: string }>(
  verdicts: readonly T[]
): readonly T[] => [...verdicts].sort((a, b) => a.path.localeCompare(b.path) || a.workflow.localeCompare(b.workflow));

const verdictsEqual = (a: readonly ClassifiedVerdict[], b: readonly ClassifiedVerdict[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** A completed run's conclusion becomes `previousRed`: red-ish -> true, success/neutral -> false, none -> null. */
const wasRed = (conclusion: string | null): boolean | null =>
  conclusion === null ? null : conclusion !== "success" && conclusion !== "neutral";

function unknownWatchVerdict(repo: string | null, sha: string | null, error: string): WatchVerdict {
  return { repo, sha, state: "unknown", isRevert: null, workflows: [], error };
}

export interface WatchRuntime {
  readonly github: WatchGitHub;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

interface WatchOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Polls until every verdict has held steady for `settleSeconds`, or until
 * `timeoutMinutes` elapses (0 takes exactly one snapshot). Exported for
 * tests that drive it with a fake `WatchGitHub` and a fake clock.
 */
export async function runWatch(request: WatchRequest, runtime: WatchRuntime): Promise<WatchVerdict> {
  const { github } = runtime;
  const start = runtime.now();
  let repoSlug: string | null = request.repo === null ? null : slug(request.repo);
  let repo: W.Repository;
  let branch: string;
  let merge: Merge;
  let expected: readonly Workflow[];
  try {
    const resolved = request.repo ?? (await github.originRepo());
    if (resolved === null)
      return unknownWatchVerdict(
        null,
        null,
        "cannot infer the repository from the origin remote; pass --repo owner/name"
      );
    repo = resolved;
    repoSlug = slug(repo);
    branch = await github.defaultBranch(repo);
    merge = await github.commit(repo, request.sha);
    expected =
      request.paths.length === 0
        ? []
        : (await github.workflows(repo)).filter((workflow) => matchesPaths(workflow.path, request.paths));
  } catch (error) {
    if (error instanceof GitHubError) return unknownWatchVerdict(repoSlug, null, error.message);
    throw error;
  }

  let verdicts: readonly ClassifiedVerdict[] = [];
  let lastChangeAt = start;
  let lastError: string | null = null;
  let timedOut = false;
  const timeoutMs = request.timeoutMinutes * 60_000;
  const settleMs = request.settleSeconds * 1000;

  while (true) {
    try {
      const [runs, after] = await Promise.all([
        github.runs(repo, branch, merge.committedAt),
        github.commitsAfter(repo, merge.sha, branch),
      ]);
      let next = classify(merge, repo, { runs, after }, expected);
      if (request.paths.length > 0) next = next.filter((verdict) => matchesPaths(verdict.path, request.paths));
      next = sortVerdicts(next);
      if (!verdictsEqual(next, verdicts)) lastChangeAt = runtime.now();
      verdicts = next;
      lastError = null;
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      lastError = error.message;
    }

    if (request.timeoutMinutes === 0) break;
    const now = runtime.now();
    const anyPending = verdicts.some((verdict) => verdict.state === "pending");
    if (lastError === null && !anyPending && now - lastChangeAt >= settleMs) break;
    if (now - start >= timeoutMs) {
      timedOut = true;
      break;
    }
    await runtime.sleep(request.intervalSeconds * 1000);
  }

  if (timedOut)
    verdicts = verdicts.map((verdict) => (verdict.state === "pending" ? { ...verdict, state: "unknown" } : verdict));

  const workflows: readonly WorkflowVerdict[] = await Promise.all(
    verdicts.map(async ({ workflowId, ...verdict }) => ({
      ...verdict,
      previousRed: await github.previousConclusion(repo, workflowId, branch, merge.committedAt).then(wasRed, (error) => {
        if (error instanceof GitHubError) return null;
        throw error;
      }),
    }))
  );

  return {
    repo: repoSlug,
    sha: merge.sha,
    state: overall([...workflows.map((verdict) => verdict.state), ...(lastError === null ? [] : ["unknown" as const])]),
    isRevert: isRevert(merge.message),
    workflows,
    error: lastError,
  };
}

function watchRuntime(): WatchRuntime {
  return {
    github: new GhWatchGitHub(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function watchExitCode(verdict: WatchVerdict): number {
  return verdict.state === "green" || verdict.state === "green-inherited" ? 0 : 2;
}

async function watchMain(argv: readonly string[], output: WatchOutput): Promise<number> {
  let verdict: WatchVerdict;
  try {
    verdict = await runWatch(parseWatchArgs(argv, output), watchRuntime());
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      output.stdout(`${JSON.stringify(unknownWatchVerdict(null, null, String(error)))}\n`);
      return 2;
    }
    output.stdout(`${JSON.stringify(unknownWatchVerdict(null, null, String(error)))}\n`);
    return 1;
  }
  output.stdout(`${JSON.stringify(verdict)}\n`);
  return watchExitCode(verdict);
}

export async function main(
  argv: readonly string[],
  runtime: Runtime = {
    github: new GhGateGitHub(),
    policyPath: join(homedir(), ".claude", "pstack", "merge-policy.json"),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }
): Promise<number> {
  if (argv[0] === "watch") return watchMain(argv.slice(1), runtime);
  let verdict: Verdict;
  try {
    verdict = await evaluate(parseArgs(argv, runtime), runtime);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    verdict = refuse(
      { repo: null, pr: null, head: null },
      error instanceof CommanderError ? "invalid-arguments" : "internal-error",
      String(error)
    );
  }
  runtime.stdout(`${JSON.stringify(verdict)}\n`);
  return exitCode(verdict);
}
