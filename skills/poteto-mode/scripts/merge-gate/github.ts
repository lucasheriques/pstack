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
  | { readonly kind: "unverified"; readonly detail: string };

export interface GateGitHub {
  originRepo(): Promise<W.Repository | null>;
  viewer(): Promise<string>;
  facts(target: W.PrContext): Promise<PrFacts>;
  head(pr: W.PrContext): Promise<string | null>;
  merge(pr: W.PrContext, head: string, method: MergeMethod): Promise<MergeResult>;
  /** The native stack `pr` belongs to, or null when it is in none. */
  stack(pr: W.PrContext): Promise<NativeStack | null>;
  /** One merge-async call on `top`, which lands every PR below it too; `below` is read back to confirm. */
  mergeStack(top: W.PrContext, head: string, method: MergeMethod, below: readonly W.PrContext[]): Promise<MergeResult>;
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
          nodes { position pullRequest { number state headRefName } }
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

async function ghJson(args: readonly string[]): Promise<unknown> {
  const result = await gh(args);
  const command = `gh ${args.slice(0, 2).join(" ")}`;
  if (result.code !== 0)
    throw new GitHubError(
      `${command} exited ${result.code}: ${firstLine(result.stderr) || "no stderr"}`
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GitHubError(`${command} printed invalid JSON`);
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
  };
}

/** A merged PR carries its merge commit; any other state is reported as GitHub names it. */
type Outcome = { readonly merged: true; readonly commit: string | null } | { readonly merged: false; readonly state: string };

/** How a read-back names what it read, so a single PR and a stack each get their own wording. */
interface Scope {
  /** Bottom first; the last is the PR the merge was requested on. */
  readonly prs: readonly W.PrContext[];
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
}

function parseMergeJob(value: unknown): MergeJob {
  const job = record(value, "merge-async");
  const details = job.details === undefined ? {} : record(job.details, "merge-async.details");
  return {
    status: text(job.status, "merge-async.status"),
    uuid: details.uuid === undefined ? null : text(details.uuid, "merge-async.details.uuid"),
    message: typeof details.message === "string" ? details.message : JSON.stringify(details),
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
      prs: [pr],
      name: () => "PR",
      reread: () => "the PR",
      what: "it",
      every: "it",
      command: "merge-gate",
    });
  }

  async mergeStack(
    top: W.PrContext,
    head: string,
    method: MergeMethod,
    below: readonly W.PrContext[]
  ): Promise<MergeResult> {
    return this.settle(await this.mergeAsync(top, head, method), {
      prs: [...below, top],
      name: (pr) => `#${pr.number}`,
      reread: (pr) => `#${pr.number}`,
      what: "the stack",
      every: "every PR",
      command: "merge-gate --stack",
    });
  }

  // A merge request can report success it did not have, or fail after merging,
  // so the verdict comes from reading every PR back.
  private async settle(attempt: Attempt, scope: Scope): Promise<MergeResult> {
    const reads = await Promise.allSettled(scope.prs.map((pr) => this.outcome(pr)));
    const unread = reads.findIndex((read) => read.status === "rejected");
    if (unread >= 0)
      return {
        kind: "unverified",
        detail: `${attempt.detail}, then reading ${scope.reread(scope.prs[unread])} back failed, so ${scope.what} may have merged. Rerun ${scope.command} without --merge.`,
      };
    const outcomes = reads.map((read) => (read as PromiseFulfilledResult<Outcome>).value);
    const top = outcomes[outcomes.length - 1];
    const unmerged = outcomes.flatMap((outcome, index) =>
      outcome.merged ? [] : [`${scope.name(scope.prs[index])} is ${outcome.state}`]
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
      ? { merged: true, commit: oid(after.mergeCommit, "mergeCommit") }
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
    let job: MergeJob;
    try {
      job = parseMergeJob(
        await ghJson([
          "api",
          endpoint,
          "-X",
          "PUT",
          "-f",
          `sha=${head}`,
          "-f",
          `merge_method=${method}`,
          "-f",
          "merge_action=direct_merge",
        ])
      );
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return {
        kind: REJECTED.test(error.message) ? "failed" : "pending",
        detail: `merge-async request failed: ${error.message}`,
      };
    }
    const { uuid } = job;
    const name = uuid === null ? "merge-async" : `merge-async job ${uuid}`;
    for (let poll = 0; ; poll += 1) {
      if (job.status === "merged") return { kind: "pending", detail: `${name} reported merged` };
      if (job.status === "failed") return { kind: "failed", detail: `${name} failed: ${firstLine(job.message)}` };
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
