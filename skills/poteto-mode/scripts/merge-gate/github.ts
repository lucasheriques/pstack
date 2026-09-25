import { ChecksUnavailable, GhGitHubReader } from "../watch-pr/github.ts";
import { readSnapshot } from "../watch-pr/policy.ts";
import type * as W from "../watch-pr/types.ts";
import type {
  Actor,
  ChangedFile,
  MergeMethod,
  PrFacts,
  Readiness,
  Review,
  ReviewState,
} from "./decide.ts";
import type { Commit, Merge, Run, WatchGitHub, Workflow } from "./watch.ts";

/** What GitHub reports after `gh pr merge`, whatever the command's exit code said. */
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

function graphql(query: string, pr: W.PrContext): Promise<unknown> {
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
        threads: await this.reader.reviewThreads(pr),
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
    let state: string;
    let merged: MergeResult | null = null;
    try {
      const after = record(repository(await graphql(OUTCOME_QUERY, pr)).pullRequest, "pullRequest");
      state = text(after.state, "state");
      if (state === "MERGED" && optionalText(after.mergedAt, "mergedAt") !== null)
        merged = { kind: "merged", commit: oid(after.mergeCommit, "mergeCommit") };
    } catch {
      return {
        kind: "unverified",
        detail: `gh pr merge exited ${result.code}, then reading the PR back failed, so it may have merged. Rerun merge-gate without --merge.`,
      };
    }
    if (merged !== null) return merged;
    return {
      kind: "failed",
      detail: `gh pr merge exited ${result.code}: ${firstLine(result.stderr) || "no stderr"}; PR is ${state}`,
    };
  }
}

const RUNS_PER_PAGE = 100;
/** GitHub Actions run pages are cheap, but a repo with a stuck queue could page forever without a cap. */
const MAX_RUN_PAGES = 10;
const CANCELLED_LIKE = new Set(["cancelled", "skipped", "stale"]);

function parseWorkflow(value: unknown, path: string): Workflow {
  const object = record(value, path);
  return {
    id: count(object.id, `${path}.id`),
    name: text(object.name, `${path}.name`),
    path: text(object.path, `${path}.path`),
  };
}

function parseRun(value: unknown, path: string): Run {
  const object = record(value, path);
  return {
    id: count(object.id, `${path}.id`),
    workflow: {
      id: count(object.workflow_id, `${path}.workflow_id`),
      name: text(object.name, `${path}.name`),
      path: text(object.path, `${path}.path`),
    },
    sha: text(object.head_sha, `${path}.head_sha`),
    status: text(object.status, `${path}.status`),
    conclusion: optionalText(object.conclusion, `${path}.conclusion`),
    createdAt: text(object.created_at, `${path}.created_at`),
    url: text(object.html_url, `${path}.html_url`),
  };
}

function parseCommit(value: unknown, path: string): Commit {
  const object = record(value, path);
  return {
    sha: text(object.sha, `${path}.sha`),
    message: text(record(object.commit, `${path}.commit`).message, `${path}.commit.message`),
  };
}

export class GhWatchGitHub implements WatchGitHub {
  private readonly reader = new GhGitHubReader();

  originRepo(): Promise<W.Repository | null> {
    return this.reader.originRepo();
  }

  async defaultBranch(repo: W.Repository): Promise<string> {
    const object = record(await ghJson(["api", `repos/${repo.owner}/${repo.repo}`]), "repo");
    return text(object.default_branch, "repo.default_branch");
  }

  async commit(repo: W.Repository, ref: string): Promise<Merge> {
    const object = record(
      await ghJson(["api", `repos/${repo.owner}/${repo.repo}/commits/${ref}`]),
      "commit"
    );
    const inner = record(object.commit, "commit.commit");
    return {
      sha: text(object.sha, "commit.sha"),
      message: text(inner.message, "commit.commit.message"),
      committedAt: text(
        record(inner.committer, "commit.commit.committer").date,
        "commit.commit.committer.date"
      ),
    };
  }

  async workflows(repo: W.Repository): Promise<readonly Workflow[]> {
    const object = record(
      await ghJson(["api", `repos/${repo.owner}/${repo.repo}/actions/workflows?per_page=100`]),
      "workflows"
    );
    return list(object.workflows, "workflows.workflows").map((value, index) =>
      parseWorkflow(value, `workflows.workflows[${index}]`)
    );
  }

  async runs(repo: W.Repository, branch: string, since: string): Promise<readonly Run[]> {
    const runs: Run[] = [];
    for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
      const object = record(
        await ghJson([
          "api",
          `repos/${repo.owner}/${repo.repo}/actions/runs?branch=${branch}&created=%3E%3D${since}&per_page=${RUNS_PER_PAGE}&page=${page}`,
        ]),
        "runs"
      );
      const batch = list(object.workflow_runs, "runs.workflow_runs");
      for (const [index, value] of batch.entries()) {
        const path = `runs.workflow_runs[${index}]`;
        if (text(record(value, path).head_branch, `${path}.head_branch`) !== branch) continue;
        runs.push(parseRun(value, path));
      }
      if (batch.length < RUNS_PER_PAGE) break;
    }
    return runs;
  }

  async commitsAfter(
    repo: W.Repository,
    sha: string,
    branch: string
  ): Promise<readonly Commit[] | null> {
    const object = record(
      await ghJson(["api", `repos/${repo.owner}/${repo.repo}/compare/${sha}...${branch}`]),
      "compare"
    );
    const status = text(object.status, "compare.status");
    if (status !== "ahead" && status !== "identical") return null;
    return list(object.commits, "compare.commits").map((value, index) =>
      parseCommit(value, `compare.commits[${index}]`)
    );
  }

  async previousConclusion(
    repo: W.Repository,
    workflow: number,
    branch: string,
    before: string
  ): Promise<string | null> {
    const object = record(
      await ghJson([
        "api",
        `repos/${repo.owner}/${repo.repo}/actions/workflows/${workflow}/runs?branch=${branch}&status=completed&created=%3C${before}&per_page=30`,
      ]),
      "previous runs"
    );
    for (const [index, value] of list(object.workflow_runs, "previous runs.workflow_runs").entries()) {
      const path = `previous runs.workflow_runs[${index}]`;
      const conclusion = optionalText(record(value, path).conclusion, `${path}.conclusion`);
      if (conclusion !== null && !CANCELLED_LIKE.has(conclusion)) return conclusion;
    }
    return null;
  }
}
