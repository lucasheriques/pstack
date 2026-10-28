import { homedir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { WatcherQueryError } from "../watch-pr/github.ts";
import type * as W from "../watch-pr/types.ts";
import { nonEmpty, parsePrNumber } from "../watch-pr/types.ts";
import { type Reason, type ReasonCode, decidePlan, plainPlan, planStack } from "./decide.ts";
import { type GateGitHub, GhGateGitHub, GitHubError, type MergeResult } from "./github.ts";
import { PolicyError, loadPolicy } from "./policy.ts";

interface Subject {
  readonly repo: string | null;
  readonly pr: number | null;
  readonly head: string | null;
  /** With --stack, the native stack and the PRs gated, bottom first; null without --stack or before the stack is read. */
  readonly stack: { readonly number: number; readonly prs: readonly number[] } | null;
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
  readonly stack: boolean;
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
      "Decide whether an agent may merge one PR under the merge policy, and with --merge, merge it.\nWith --stack, gate every open PR from the bottom of its GitHub native stack up to this one, and merge them together.\nPrints one JSON verdict. Exit 0: mergeable or merged, 2: refused, 1: internal error."
    )
    .configureOutput({ writeOut: runtime.stdout, writeErr: runtime.stderr })
    .exitOverride()
    .argument("<pr>", "PR number or GitHub PR URL", target)
    .option("--repo <owner/name>", "repository; defaults to the checkout's origin", repository)
    .option("--merge", "merge when the verdict is merge", false)
    .option("--stack", "gate and merge native stack positions 1 to this PR as one unit", false);
  program.parse(argv, { from: "user" });
  const options = program.opts<{
    readonly repo?: W.Repository;
    readonly merge: boolean;
    readonly stack: boolean;
  }>();
  const pr: ReturnType<typeof target> = program.processedArgs[0];
  if (pr.repo !== null && options.repo !== undefined && slug(pr.repo).toLowerCase() !== slug(options.repo).toLowerCase())
    program.error(`error: PR URL is in ${slug(pr.repo)} but --repo is ${slug(options.repo)}`);
  return {
    number: pr.number,
    repo: pr.repo ?? options.repo ?? null,
    merge: options.merge,
    stack: options.stack,
  };
}

const refuse = (subject: Subject, reasons: W.NonEmpty<Reason>): Verdict => ({
  ...subject,
  decision: "refuse",
  merged: false,
  mergeCommit: null,
  reasons,
});

const refuseOne = (subject: Subject, code: ReasonCode, detail: string): Verdict => refuse(subject, [{ code, detail }]);

/** A merge decision, after the merge when `merge` is given. */
function approve(subject: Subject, merge: MergeResult | null): Verdict {
  if (merge === null) return { ...subject, decision: "merge", merged: false, mergeCommit: null, reasons: [] };
  return merge.kind === "merged"
    ? { ...subject, decision: "merge", merged: true, mergeCommit: merge.commit, reasons: [] }
    : refuseOne(subject, merge.kind === "unverified" ? "merge-unverified" : "merge-failed", merge.detail);
}

async function evaluate(request: Request, runtime: Runtime): Promise<Verdict> {
  const { github } = runtime;
  let subject: Subject = {
    repo: request.repo === null ? null : slug(request.repo),
    pr: request.number,
    head: null,
    stack: null,
  };
  try {
    const policy = await loadPolicy(runtime.policyPath);
    const repo = request.repo ?? (await github.originRepo());
    if (repo === null)
      return refuseOne(subject, "invalid-arguments", "cannot infer the repository from the origin remote; pass --repo owner/name");
    subject = { ...subject, repo: slug(repo) };
    const at = (number: W.PrNumber): W.PrContext => ({ ...repo, number });
    const [viewer, stack] = await Promise.all([github.viewer(), request.stack ? github.stack(at(request.number)) : undefined]);
    if (stack === null)
      return refuseOne(subject, "invalid-arguments", `#${request.number} is not in a native stack; rerun without --stack`);
    const { plan, reasons: blocked } =
      stack === undefined ? { plan: plainPlan(request.number), reasons: [] } : planStack(stack);
    if (plan.stack !== null)
      subject = { ...subject, stack: { number: plan.stack, prs: [...plan.below, plan.top].map((pr) => pr.number) } };
    const unplanned = nonEmpty(blocked);
    if (unplanned !== null) return refuse(subject, unplanned);
    const [top, ...below] = await Promise.all(
      [plan.top, ...plan.below].map(async ({ number, base }) => ({ facts: await github.facts(at(number)), base }))
    );
    subject = { ...subject, repo: slug(top.facts.pr), pr: top.facts.pr.number, head: top.facts.head };
    const decision = decidePlan(policy, viewer, plan.stack, below, top);
    if (decision.kind === "refuse") return refuse(subject, decision.reasons);
    if (!request.merge) return approve(subject, null);
    const gated = [...below, top].map(({ facts }) => facts);
    const heads = await Promise.all(gated.map((facts) => github.head(facts.pr)));
    const moved = gated.findIndex((facts, index) => heads[index] !== facts.head);
    if (moved >= 0) {
      const { pr, head } = gated[moved];
      const tag = plan.stack === null ? "" : `#${pr.number}: `;
      return refuseOne(subject, "head-moved", `${tag}head was ${head}, then ${heads[moved] ?? "unknown"} before merging`);
    }
    return approve(
      subject,
      plan.stack === null
        ? await github.merge(top.facts.pr, top.facts.head, decision.method)
        : await github.mergeStack(top.facts.pr, top.facts.head, decision.method, below.map(({ facts }) => facts.pr))
    );
  } catch (error) {
    if (error instanceof PolicyError) return refuseOne(subject, "policy-invalid", error.message);
    if (error instanceof GitHubError || error instanceof WatcherQueryError)
      return refuseOne(subject, "github-error", error.message);
    return refuseOne(subject, "internal-error", String(error));
  }
}

function exitCode(verdict: Verdict): number {
  if (verdict.decision === "merge") return 0;
  return verdict.reasons.some((reason) => reason.code === "internal-error" || reason.code === "merge-unverified") ? 1 : 2;
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
  let verdict: Verdict;
  try {
    verdict = await evaluate(parseArgs(argv, runtime), runtime);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    verdict = refuseOne(
      { repo: null, pr: null, head: null, stack: null },
      error instanceof CommanderError ? "invalid-arguments" : "internal-error",
      String(error)
    );
  }
  runtime.stdout(`${JSON.stringify(verdict)}\n`);
  return exitCode(verdict);
}
