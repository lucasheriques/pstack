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

/** What GitHub reports after `gh pr merge`, whatever the command's exit code said. */
export type MergeResult =
  | { readonly kind: "merged"; readonly commit: string | null }
  | { readonly kind: "failed"; readonly detail: string };

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
    const after = record(repository(await graphql(OUTCOME_QUERY, pr)).pullRequest, "pullRequest");
    const state = text(after.state, "state");
    if (state === "MERGED" && optionalText(after.mergedAt, "mergedAt") !== null)
      return { kind: "merged", commit: oid(after.mergeCommit, "mergeCommit") };
    return {
      kind: "failed",
      detail: `gh pr merge exited ${result.code}: ${firstLine(result.stderr) || "no stderr"}; PR is ${state}`,
    };
  }
}
