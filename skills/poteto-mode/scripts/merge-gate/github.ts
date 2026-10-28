import { ChecksUnavailable, GhGitHubReader, resolveReviewThreads } from "../watch-pr/github.ts";
import { readSnapshot } from "../watch-pr/policy.ts";
import type * as W from "../watch-pr/types.ts";
import { parsePrNumber } from "../watch-pr/types.ts";
import type {
  Actor,
  ChangedFile,
  MergeMethod,
  NativeStack,
  PrFacts,
  Readiness,
  Review,
  ReviewState,
  StackEntry,
} from "./decide.ts";

/** What GitHub reports after the merge request, whatever the request itself said. */
export type MergeResult =
  | { readonly kind: "merged"; readonly commit: string | null }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "unverified"; readonly detail: string }
  /** A PR merged with a head other than the one gated. */
  | { readonly kind: "ungated"; readonly detail: string };

/** A PR and the head merge-gate gated on it. */
export interface Pinned {
  readonly pr: W.PrContext;
  readonly head: string;
}

export interface GateGitHub {
  originRepo(): Promise<W.Repository | null>;
  viewer(): Promise<string>;
  facts(target: W.PrContext): Promise<PrFacts>;
  head(pr: W.PrContext): Promise<string | null>;
  merge(pr: W.PrContext, head: string, method: MergeMethod): Promise<MergeResult>;
  /** The native stack `pr` belongs to, or null when it is in none. */
  stack(pr: W.PrContext): Promise<NativeStack | null>;
  /**
   * One merge-async call on the last PR, pinned to its head, lands every PR below it too.
   * GitHub pins only that head, so every PR is read back and its merged head checked against its gated one.
   */
  mergeStack(range: readonly Pinned[], method: MergeMethod): Promise<MergeResult>;
}

/** A gh call failed or answered with a shape merge-gate does not recognize. */
export class GitHubError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "GitHubError";
  }
}

export const PR_QUERY = `
query MergeGatePr($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequest(number: $pr) {
      headRefOid
      baseRefName
      stack { number }
      changedFiles
      author { __typename login }
      reviewThreads { totalCount }
      reviews(last: 100) {
        totalCount
        nodes {
          state
          authorAssociation
          author { __typename login }
          commit { oid }
        }
      }
    }
  }
}
`;
const OUTCOME_QUERY = `
query MergeGateOutcome($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state
      mergedAt
      headRefOid
      mergeCommit { oid }
    }
  }
}
`;
const STACK_QUERY = `
query MergeGateStack($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      stack {
        number
        entries(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { position pullRequest { number state headRefName baseRefName } }
        }
      }
    }
  }
}
`;
const MAX_STACK_PAGES = 10;
const ENTRY_STATES = ["OPEN", "CLOSED", "MERGED"] as const satisfies readonly StackEntry["state"][];
/** GitHub refuses `gh pr merge` for a PR in a native stack and wants its merge-async endpoint. */
const STACKED = /part of a stack/;
/** Keeps a stuck job well inside an agent's two-minute command timeout. */
const MERGE_POLL_MS = 2_000;
const MAX_MERGE_POLLS = 30;
/** Only a 4xx proves GitHub queued nothing; a 5xx, a timeout or a garbled body may hide a queued job. */
const REJECTED = /\(HTTP 4\d\d\)/;
/** merge-async answers 409 when a merge request for the PR already exists, and returns that request. */
const CONFLICT = /\(HTTP 409\)/;
const FILES_PER_PAGE = 100;
/** GitHub's pull request files endpoint stops at 3000 files. */
const MAX_FILE_PAGES = 30;
const REVIEW_STATES = [
  "PENDING",
  "COMMENTED",
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
] as const satisfies readonly ReviewState[];

/** How a merge request ended before the read-back; `pending` means GitHub may still merge it. */
interface Attempt {
  readonly kind: "failed" | "pending";
  readonly detail: string;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function gh(args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

const firstLine = (text: string): string => (text.trim().split(/\r?\n/, 1)[0] ?? "").slice(0, 240);

function graphql(query: string, pr: W.PrContext, cursor: string | null = null): Promise<unknown> {
  return ghJson([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${pr.owner}`,
    "-f",
    `repo=${pr.repo}`,
    "-F",
    `pr=${pr.number}`,
    ...(cursor === null ? [] : ["-f", `after=${cursor}`]),
  ]);
}

const describeCommand = (args: readonly string[]): string => `gh ${args.slice(0, 2).join(" ")}`;

async function ghJson(args: readonly string[]): Promise<unknown> {
  const result = await gh(args);
  if (result.code !== 0)
    throw new GitHubError(
      `${describeCommand(args)} exited ${result.code}: ${firstLine(result.stderr) || "no stderr"}`
    );
  return body(args, result);
}

function body(args: readonly string[], result: CommandResult): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GitHubError(`${describeCommand(args)} printed invalid JSON`);
  }
}

function invalid(path: string, value: unknown): never {
  throw new GitHubError(`unexpected ${path}: ${JSON.stringify(value) ?? String(value)}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : invalid(path, value);
}
function list(value: unknown, path: string): readonly unknown[] {
  return Array.isArray(value) ? value : invalid(path, value);
}
function text(value: unknown, path: string): string {
  return typeof value === "string" ? value : invalid(path, value);
}
function optionalText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}
function count(value: unknown, path: string): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : invalid(path, value);
}
function prNumber(value: unknown, path: string): W.PrNumber {
  try {
    return parsePrNumber(value);
  } catch {
    return invalid(path, value);
  }
}
function actor(value: unknown, path: string): Actor | null {
  if (value === null) return null;
  const object = record(value, path);
  return {
    login: text(object.login, `${path}.login`),
    type: text(object.__typename, `${path}.__typename`),
  };
}
function reviewState(value: unknown, path: string): ReviewState {
  return REVIEW_STATES.find((state) => state === value) ?? invalid(path, value);
}

function parseReview(value: unknown, index: number): Review {
  const path = `reviews[${index}]`;
  const object = record(value, path);
  return {
    author: actor(object.author, `${path}.author`),
    authorAssociation: text(object.authorAssociation, `${path}.authorAssociation`),
    state: reviewState(object.state, `${path}.state`),
    commit: oid(object.commit, `${path}.commit`),
  };
}

function repository(response: unknown): Record<string, unknown> {
  return record(record(record(response, "response").data, "data").repository, "repository");
}

function oid(commit: unknown, path: string): string | null {
  return commit === null ? null : text(record(commit, path).oid, `${path}.oid`);
}

export function parsePullRequest(
  value: unknown,
  number: W.PrNumber
): Omit<PrFacts, "files" | "readiness"> {
  const repo = repository(value);
  const [owner, name, ...rest] = text(repo.nameWithOwner, "nameWithOwner").split("/");
  if (owner === undefined || name === undefined || rest.length > 0)
    return invalid("nameWithOwner", repo.nameWithOwner);
  const pr = record(repo.pullRequest, "pullRequest");
  return {
    pr: { owner, repo: name, number },
    head: text(pr.headRefOid, "headRefOid"),
    base: optionalText(pr.baseRefName, "baseRefName"),
    defaultBranch:
      repo.defaultBranchRef === null
        ? null
        : text(record(repo.defaultBranchRef, "defaultBranchRef").name, "defaultBranchRef.name"),
    stack: pr.stack === null ? null : count(record(pr.stack, "stack").number, "stack.number"),
    author: actor(pr.author, "author"),
    reviews: list(record(pr.reviews, "reviews").nodes, "reviews.nodes").map(parseReview),
    reviewCount: count(record(pr.reviews, "reviews").totalCount, "reviews.totalCount"),
    reviewThreadCount: count(
      record(pr.reviewThreads, "reviewThreads").totalCount,
      "reviewThreads.totalCount"
    ),
    changedFileCount: count(pr.changedFiles, "changedFiles"),
  };
}

function parseFile(value: unknown, index: number): ChangedFile {
  const object = record(value, `files[${index}]`);
  return {
    path: text(object.filename, `files[${index}].filename`),
    previousPath:
      object.previous_filename === undefined || object.previous_filename === null
        ? null
        : text(object.previous_filename, `files[${index}].previous_filename`),
  };
}

function parseStackEntry(value: unknown, index: number): StackEntry {
  const path = `stack.entries[${index}]`;
  const object = record(value, path);
  const pr = record(object.pullRequest, `${path}.pullRequest`);
  return {
    position: count(object.position, `${path}.position`),
    number: prNumber(pr.number, `${path}.pullRequest.number`),
    state: ENTRY_STATES.find((state) => state === pr.state) ?? invalid(`${path}.pullRequest.state`, pr.state),
    headRefName: text(pr.headRefName, `${path}.pullRequest.headRefName`),
    baseRefName: text(pr.baseRefName, `${path}.pullRequest.baseRefName`),
  };
}

/** A merged PR carries its merge commit and the head it merged; any other state is reported as GitHub names it. */
type Outcome =
  | { readonly merged: true; readonly commit: string | null; readonly head: string }
  | { readonly merged: false; readonly state: string };

/** How a read-back names what it read, so a single PR and a stack each get their own wording. */
interface Scope {
  /** Bottom first; the last is the PR the merge was requested on. */
  readonly prs: readonly Pinned[];
  readonly name: (pr: W.PrContext) => string;
  readonly reread: (pr: W.PrContext) => string;
  readonly what: string;
  readonly every: string;
  readonly command: string;
}

// Entries arrive in pages; positions must run 1..n with no gap, and the target
// must be among them, or the read is incomplete.
function nativeStack(number: number, target: W.PrNumber, entries: readonly StackEntry[]): NativeStack {
  const sorted = [...entries].sort((a, b) => a.position - b.position);
  const index = sorted.findIndex((entry) => entry.number === target);
  const top = sorted[index];
  if (top === undefined || sorted.some((entry, position) => entry.position !== position + 1))
    throw new GitHubError(
      `stack #${number} lists positions ${sorted.map((entry) => entry.position).join(", ")}${top === undefined ? ` without #${target}` : ""}`
    );
  return { number, below: sorted.slice(0, index), target: top };
}

interface MergeJob {
  readonly status: string;
  readonly uuid: string | null;
  readonly message: string;
  /** The head the job will merge and its method; GitHub reports them on a pending job. */
  readonly head: string | null;
  readonly method: string | null;
}

function parseMergeJob(value: unknown): MergeJob {
  const job = record(value, "merge-async");
  const details = job.details === undefined ? {} : record(job.details, "merge-async.details");
  const detail = (field: string): string | null =>
    details[field] === undefined ? null : text(details[field], `merge-async.details.${field}`);
  return {
    status: text(job.status, "merge-async.status"),
    uuid: detail("uuid"),
    message: typeof details.message === "string" ? details.message : JSON.stringify(details),
    head: detail("expected_head_sha"),
    method: detail("merge_method"),
  };
}

export class GhGateGitHub implements GateGitHub {
  private readonly reader = new GhGitHubReader();

  originRepo(): Promise<W.Repository | null> {
    return this.reader.originRepo();
  }

  async viewer(): Promise<string> {
    return text(record(await ghJson(["api", "user"]), "user").login, "user.login");
  }

  async facts(target: W.PrContext): Promise<PrFacts> {
    const core = parsePullRequest(await graphql(PR_QUERY, target), target.number);
    const files = await this.files(core.pr);
    return { ...core, files, readiness: await this.readiness(core.pr) };
  }

  private async files(pr: W.PrContext): Promise<readonly ChangedFile[]> {
    const files: ChangedFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
      const batch = list(
        await ghJson([
          "api",
          `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
        ]),
        "files"
      );
      files.push(...batch.map((file, index) => parseFile(file, files.length + index)));
      if (batch.length < FILES_PER_PAGE) break;
    }
    return files;
  }

  private async readiness(pr: W.PrContext): Promise<Readiness> {
    try {
      return await readSnapshot({
        reader: this.reader,
        context: pr,
        pendingHistory: "include",
        allowDraft: false,
      });
    } catch (error) {
      if (!(error instanceof ChecksUnavailable)) throw error;
      return {
        kind: "no-checks",
        context: pr,
        facts: await this.reader.pullRequest(pr),
        threads: await resolveReviewThreads(this.reader, pr),
      };
    }
  }

  async head(pr: W.PrContext): Promise<string | null> {
    return (await this.reader.pullRequest(pr)).headRefOid;
  }

  async merge(pr: W.PrContext, head: string, method: MergeMethod): Promise<MergeResult> {
    const result = await gh([
      "pr",
      "merge",
      String(pr.number),
      "--repo",
      `${pr.owner}/${pr.repo}`,
      "--match-head-commit",
      head,
      method === "merge" ? "--merge" : "--squash",
    ]);
    const attempt: Attempt =
      result.code !== 0 && STACKED.test(result.stderr)
        ? await this.mergeAsync(pr, head, method)
        : { kind: "failed", detail: `gh pr merge exited ${result.code}: ${firstLine(result.stderr) || "no stderr"}` };
    return this.settle(attempt, {
      prs: [{ pr, head }],
      name: () => "PR",
      reread: () => "the PR",
      what: "it",
      every: "it",
      command: "merge-gate",
    });
  }

  async mergeStack(range: readonly Pinned[], method: MergeMethod): Promise<MergeResult> {
    const top = range[range.length - 1];
    return this.settle(await this.mergeAsync(top.pr, top.head, method), {
      prs: range,
      name: ({ number }) => `#${number}`,
      reread: ({ number }) => `#${number}`,
      what: "the stack",
      every: "every PR",
      command: "merge-gate --stack",
    });
  }

  // A merge request can report success it did not have, or fail after merging,
  // so the verdict comes from reading every PR back. merge-async pins only the
  // top head, so a lower PR pushed after the pre-merge check lands unpinned;
  // the read-back catches it after the fact but cannot stop it.
  private async settle(attempt: Attempt, scope: Scope): Promise<MergeResult> {
    const reads = await Promise.allSettled(scope.prs.map(({ pr }) => this.outcome(pr)));
    const unread = reads.findIndex((read) => read.status === "rejected");
    if (unread >= 0)
      return {
        kind: "unverified",
        detail: `${attempt.detail}, then reading ${scope.reread(scope.prs[unread].pr)} back failed, so ${scope.what} may have merged. Rerun ${scope.command} without --merge.`,
      };
    const outcomes = reads.map((read) => (read as PromiseFulfilledResult<Outcome>).value);
    const top = outcomes[outcomes.length - 1];
    const ungated = outcomes.flatMap((outcome, index) => {
      const { pr, head } = scope.prs[index];
      return outcome.merged && outcome.head !== head
        ? [`${scope.name(pr)} merged head ${outcome.head}, but merge-gate gated ${head}`]
        : [];
    });
    if (ungated.length > 0)
      return {
        kind: "ungated",
        detail: `${attempt.detail}; ${ungated.join("; ")}. Commits merge-gate never gated landed${top.merged && top.commit !== null ? ` in ${top.commit}` : ""}, so a human must review what merged before anything else lands.`,
      };
    const unmerged = outcomes.flatMap((outcome, index) =>
      outcome.merged ? [] : [`${scope.name(scope.prs[index].pr)} is ${outcome.state}`]
    );
    if (top.merged && unmerged.length === 0) return { kind: "merged", commit: top.commit };
    const detail = `${attempt.detail}; ${unmerged.join(", ")}`;
    // merge-async is atomic, so a failed job that left every PR open merged nothing.
    return attempt.kind === "failed" && unmerged.length === scope.prs.length
      ? { kind: "failed", detail }
      : {
          kind: "unverified",
          detail: `${detail}, so ${scope.what} may still merge. Wait for gh pr view to show ${scope.every} settled before rerunning ${scope.command} --merge.`,
        };
  }

  private async outcome(pr: W.PrContext): Promise<Outcome> {
    const after = record(repository(await graphql(OUTCOME_QUERY, pr)).pullRequest, "pullRequest");
    const state = text(after.state, "state");
    return state === "MERGED" && optionalText(after.mergedAt, "mergedAt") !== null
      ? { merged: true, commit: oid(after.mergeCommit, "mergeCommit"), head: text(after.headRefOid, "headRefOid") }
      : { merged: false, state };
  }

  async stack(pr: W.PrContext): Promise<NativeStack | null> {
    const entries: StackEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_STACK_PAGES; page += 1) {
      const pull = record(repository(await graphql(STACK_QUERY, pr, cursor)).pullRequest, "pullRequest");
      if (pull.stack === null) return null;
      const stack = record(pull.stack, "stack");
      const connection = record(stack.entries, "stack.entries");
      entries.push(
        ...list(connection.nodes, "stack.entries.nodes").map((entry, index) => parseStackEntry(entry, entries.length + index))
      );
      const pageInfo = record(connection.pageInfo, "stack.entries.pageInfo");
      if (pageInfo.hasNextPage !== true) return nativeStack(count(stack.number, "stack.number"), pr.number, entries);
      cursor = text(pageInfo.endCursor, "stack.entries.pageInfo.endCursor");
    }
    throw new GitHubError(`stack entries for #${pr.number} exceed ${MAX_STACK_PAGES} pages`);
  }

  private async mergeAsync(pr: W.PrContext, head: string, method: MergeMethod): Promise<Attempt> {
    const endpoint = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge-async`;
    const put = ["api", endpoint, "-X", "PUT", "-f", `sha=${head}`, "-f", `merge_method=${method}`, "-f", "merge_action=direct_merge"];
    const result = await gh(put);
    const existing = result.code !== 0 && CONFLICT.test(result.stderr);
    if (result.code !== 0 && !existing) {
      const detail = `merge-async request failed: ${describeCommand(put)} exited ${result.code}: ${firstLine(result.stderr) || "no stderr"}`;
      return { kind: REJECTED.test(result.stderr) ? "failed" : "pending", detail };
    }
    let job: MergeJob;
    try {
      job = parseMergeJob(body(put, result));
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      const request = existing ? "merge-async reported an existing merge request (HTTP 409)" : "merge-async request failed";
      return { kind: "pending", detail: `${request}: ${error.message}` };
    }
    const { uuid } = job;
    const name = uuid === null ? "merge-async" : `merge-async job ${uuid}`;
    // An existing request for another head would merge what merge-gate did not gate.
    if (existing && job.head !== null && job.head !== head)
      return {
        kind: "pending",
        detail: `another merge request, ${name}, already exists with different options (head ${job.head}, method ${job.method ?? "unknown"}), so merge-gate did not poll it`,
      };
    for (let poll = 0; ; poll += 1) {
      if (job.status === "merged") return { kind: "pending", detail: `${name} reported merged` };
      // A 409 returns a job merge-gate did not submit, so its failure is never reported as this merge's.
      if (job.status === "failed")
        return { kind: existing ? "pending" : "failed", detail: `${name} failed: ${firstLine(job.message)}` };
      if (job.status !== "pending")
        return { kind: "pending", detail: `${name} reported unknown status ${job.status}` };
      if (uuid === null) return { kind: "pending", detail: "merge-async queued a job without a uuid" };
      if (poll === MAX_MERGE_POLLS)
        return { kind: "pending", detail: `${name} still pending after ${MAX_MERGE_POLLS} polls` };
      if (poll > 0) await Bun.sleep(MERGE_POLL_MS);
      try {
        job = parseMergeJob(await ghJson(["api", `${endpoint}/${uuid}`]));
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        return { kind: "pending", detail: `polling ${name} failed: ${error.message}` };
      }
    }
  }
}
