import type * as W from "../watch-pr/types.ts";

export type WorkflowState =
  | "green"
  | "red-own"
  | "pending"
  | "green-inherited"
  | "red-inherited"
  | "waiting-approval"
  | "unknown";

export interface Workflow {
  readonly id: number;
  readonly name: string;
  readonly path: string;
}

/** A GitHub Actions run, as `GET /repos/{o}/{r}/actions/runs` reports it. */
export interface Run {
  readonly id: number;
  readonly workflow: Workflow;
  readonly sha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly url: string;
}

export interface Commit {
  readonly sha: string;
  readonly message: string;
}

/** What one poll reads. Pure code turns it into verdicts. */
export interface Snapshot {
  /** Default-branch runs created at or after the merge commit. */
  readonly runs: readonly Run[];
  /** Default-branch commits after the merge commit, oldest first, or null when the branch does not contain it. */
  readonly after: readonly Commit[] | null;
}

export interface WorkflowVerdict {
  readonly workflow: string;
  readonly path: string;
  readonly state: WorkflowState;
  /** The run that decided the state, or null when none has. */
  readonly run: string | null;
  readonly sha: string | null;
  /** The last completed default-branch run before the merge was red; null when there is none. */
  readonly previousRed: boolean | null;
}

/**
 * `classify`'s output, before `previousRed` is filled in. Carries the
 * workflow id so the polling loop can call `previousConclusion` without a
 * second pass over the runs.
 */
export type ClassifiedVerdict = Omit<WorkflowVerdict, "previousRed"> & {
  readonly workflowId: number;
};

export interface WatchVerdict {
  readonly repo: string | null;
  readonly sha: string | null;
  readonly state: WorkflowState;
  readonly isRevert: boolean | null;
  readonly workflows: readonly WorkflowVerdict[];
  readonly error: string | null;
}

export interface Merge {
  readonly sha: string;
  readonly message: string;
  readonly committedAt: string;
}

export interface WatchGitHub {
  originRepo(): Promise<W.Repository | null>;
  defaultBranch(repo: W.Repository): Promise<string>;
  commit(repo: W.Repository, ref: string): Promise<Merge>;
  workflows(repo: W.Repository): Promise<readonly Workflow[]>;
  runs(repo: W.Repository, branch: string, since: string): Promise<readonly Run[]>;
  /** Commits on `branch` after `sha`, oldest first; null when `branch` does not contain `sha`. */
  commitsAfter(repo: W.Repository, sha: string, branch: string): Promise<readonly Commit[] | null>;
  /** Conclusion of the newest completed run of `workflow` on `branch` created before `before`, skipping cancelled, skipped, and stale runs. */
  previousConclusion(repo: W.Repository, workflow: number, branch: string, before: string): Promise<string | null>;
}

const REVERTS_TRAILER = /^Reverts [\w.-]+\/[\w.-]+#\d+/m;
const subjectOf = (message: string): string => message.split("\n", 1)[0] ?? "";

export function isRevert(message: string): boolean {
  return (
    subjectOf(message).startsWith('Revert "') ||
    message.includes("This reverts commit ") ||
    REVERTS_TRAILER.test(message)
  );
}

export function reverts(message: string, merge: Merge, repo: W.Repository): boolean {
  if (message.includes(`This reverts commit ${merge.sha}`)) return true;
  const mergeSubject = subjectOf(merge.message);
  if (subjectOf(message).startsWith(`Revert "${mergeSubject}"`)) return true;
  const prNumber = /\(#(\d+)\)$/.exec(mergeSubject)?.[1];
  return prNumber !== undefined && message.includes(`Reverts ${repo.owner}/${repo.repo}#${prNumber}`);
}

/** What one run, on its own, resolves to. `classify` turns this into a workflow-level state. */
type Outcome = "waiting-approval" | "pending" | "green" | "superseded" | "red";

function outcomeOf(run: Run): Outcome {
  if (run.status === "waiting") return "waiting-approval";
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success" || run.conclusion === "neutral") return "green";
  if (run.conclusion === "cancelled" || run.conclusion === "skipped" || run.conclusion === "stale")
    return "superseded";
  return "red"; // failure, timed_out, action_required, startup_failure, null
}

/** How the merge run's own outcome settles a verdict directly; `superseded` instead triggers inheritance. */
const DIRECT_STATE: Record<Exclude<Outcome, "superseded" | "red">, WorkflowState> = {
  "waiting-approval": "waiting-approval",
  pending: "pending",
  green: "green",
};

/** How an inherited candidate's outcome settles a verdict. */
const INHERITED_STATE: Record<Exclude<Outcome, "superseded">, WorkflowState> = {
  "waiting-approval": "waiting-approval",
  pending: "pending",
  green: "green-inherited",
  red: "red-inherited",
};

function eligibleCommits(
  merge: Merge,
  repo: W.Repository,
  after: readonly Commit[] | null
): readonly Commit[] {
  if (after === null) return [];
  const revertedAt = after.findIndex((commit) => reverts(commit.message, merge, repo));
  return revertedAt === -1 ? after : after.slice(0, revertedAt);
}

/** The earliest non-superseded run among a workflow's runs on eligible later commits, or none. */
function inherit(
  workflowRuns: readonly Run[],
  eligible: ReadonlySet<string>,
  mergeRun: Run
): Pick<ClassifiedVerdict, "state" | "run" | "sha"> {
  const candidates = workflowRuns
    .filter((candidate) => eligible.has(candidate.sha))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const candidate of candidates) {
    const outcome = outcomeOf(candidate);
    if (outcome === "superseded") continue;
    return { state: INHERITED_STATE[outcome], run: candidate.url, sha: candidate.sha };
  }
  return { state: "pending", run: mergeRun.url, sha: mergeRun.sha };
}

export function classify(
  merge: Merge,
  repo: W.Repository,
  snapshot: Snapshot,
  expected: readonly Workflow[]
): readonly ClassifiedVerdict[] {
  const runsByWorkflow = new Map<number, Run[]>();
  const workflows = new Map<number, Workflow>();
  for (const run of snapshot.runs) {
    const runs = runsByWorkflow.get(run.workflow.id);
    if (runs === undefined) runsByWorkflow.set(run.workflow.id, [run]);
    else runs.push(run);
    if (run.sha === merge.sha) workflows.set(run.workflow.id, run.workflow);
  }
  for (const workflow of expected) workflows.set(workflow.id, workflow);

  const eligible = new Set(eligibleCommits(merge, repo, snapshot.after).map((commit) => commit.sha));

  return [...workflows.values()].map((workflow) => {
    const runs = runsByWorkflow.get(workflow.id) ?? [];
    const mergeRun = runs
      .filter((run) => run.sha === merge.sha)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (mergeRun === undefined)
      return {
        workflowId: workflow.id,
        workflow: workflow.name,
        path: workflow.path,
        state: "pending" as const,
        run: null,
        sha: null,
      };
    const outcome = outcomeOf(mergeRun);
    const settled =
      outcome === "superseded"
        ? inherit(runs, eligible, mergeRun)
        : outcome === "red"
          ? { state: "red-own" as const, run: mergeRun.url, sha: mergeRun.sha }
          : { state: DIRECT_STATE[outcome], run: mergeRun.url, sha: mergeRun.sha };
    return { workflowId: workflow.id, workflow: workflow.name, path: workflow.path, ...settled };
  });
}

const OVERALL_PRECEDENCE: readonly WorkflowState[] = [
  "red-own",
  "red-inherited",
  "unknown",
  "waiting-approval",
  "pending",
  "green-inherited",
  "green",
];

export function overall(states: readonly WorkflowState[]): WorkflowState {
  for (const candidate of OVERALL_PRECEDENCE) if (states.includes(candidate)) return candidate;
  return "green";
}
