import { homedir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { WatcherQueryError } from "../watch-pr/github.ts";
import type * as W from "../watch-pr/types.ts";
import { parsePrNumber } from "../watch-pr/types.ts";
import { type Reason, type ReasonCode, decide } from "./decide.ts";
import { type GateGitHub, GhGateGitHub, GitHubError } from "./github.ts";
import { PolicyError, loadPolicy } from "./policy.ts";

interface Subject {
  readonly repo: string | null;
  readonly pr: number | null;
  readonly head: string | null;
}

export type Verdict = Subject &
  (
    | { readonly decision: "merge"; readonly merged: boolean; readonly reasons: readonly [] }
    | { readonly decision: "refuse"; readonly merged: false; readonly reasons: W.NonEmpty<Reason> }
  );

interface Request {
  readonly number: W.PrNumber;
  readonly repo: W.Repository | null;
  readonly merge: boolean;
  readonly policy: string;
}

export interface Runtime {
  readonly github: GateGitHub;
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
    .option("--merge", "merge when the verdict is merge", false)
    .option(
      "--policy <path>",
      "merge policy JSON",
      join(homedir(), ".claude", "pstack", "merge-policy.json")
    );
  program.parse(argv, { from: "user" });
  const options = program.opts<{
    readonly repo?: W.Repository;
    readonly merge: boolean;
    readonly policy: string;
  }>();
  const pr: ReturnType<typeof target> = program.processedArgs[0];
  if (pr.repo !== null && options.repo !== undefined && slug(pr.repo).toLowerCase() !== slug(options.repo).toLowerCase())
    program.error(`error: PR URL is in ${slug(pr.repo)} but --repo is ${slug(options.repo)}`);
  return {
    number: pr.number,
    repo: pr.repo ?? options.repo ?? null,
    merge: options.merge,
    policy: options.policy,
  };
}

const refuse = (subject: Subject, code: ReasonCode, detail: string): Verdict => ({
  ...subject,
  decision: "refuse",
  merged: false,
  reasons: [{ code, detail }],
});

async function evaluate(request: Request, github: GateGitHub): Promise<Verdict> {
  let subject: Subject = {
    repo: request.repo === null ? null : slug(request.repo),
    pr: request.number,
    head: null,
  };
  try {
    const policy = await loadPolicy(request.policy);
    const repo = request.repo ?? (await github.originRepo());
    if (repo === null)
      return refuse(subject, "invalid-arguments", "cannot infer the repository from the origin remote; pass --repo owner/name");
    subject = { ...subject, repo: slug(repo) };
    const viewer = await github.viewer();
    const facts = await github.facts({ ...repo, number: request.number });
    subject = { repo: slug(facts.pr), pr: facts.pr.number, head: facts.head };
    const decision = decide(policy, facts, viewer);
    if (decision.kind === "refuse")
      return { ...subject, decision: "refuse", merged: false, reasons: decision.reasons };
    if (!request.merge) return { ...subject, decision: "merge", merged: false, reasons: [] };
    const head = await github.head(facts.pr);
    if (head !== facts.head)
      return refuse(subject, "head-moved", `head was ${facts.head}, then ${head ?? "unknown"} before merging`);
    const merge = await github.merge(facts.pr, facts.head, decision.method);
    return merge.kind === "merged"
      ? { ...subject, decision: "merge", merged: true, reasons: [] }
      : refuse(subject, "merge-failed", merge.detail);
  } catch (error) {
    if (error instanceof PolicyError) return refuse(subject, "policy-invalid", error.message);
    if (error instanceof GitHubError || error instanceof WatcherQueryError)
      return refuse(subject, "github-error", error.message);
    return refuse(subject, "internal-error", String(error));
  }
}

function exitCode(verdict: Verdict): number {
  if (verdict.decision === "merge") return 0;
  return verdict.reasons.some((reason) => reason.code === "internal-error") ? 1 : 2;
}

export async function main(
  argv: readonly string[],
  runtime: Runtime = {
    github: new GhGateGitHub(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }
): Promise<number> {
  let verdict: Verdict;
  try {
    verdict = await evaluate(parseArgs(argv, runtime), runtime.github);
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
