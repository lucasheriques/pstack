import type * as W from "../watch-pr/types.ts";
import { nonEmpty } from "../watch-pr/types.ts";
import { type Policy, type RepoPolicy, repoPolicy } from "./policy.ts";

export type ReasonCode =
  | "repo-not-allowed"
  | "not-open"
  | "draft"
  | "not-author"
  | "base-not-trunk"
  | "not-mergeable"
  | "changes-requested"
  | "checks-failed"
  | "checks-pending"
  | "checks-missing"
  | "threads-unresolved"
  | "threads-unverified"
  | "reviews-unverified"
  | "head-moved"
  | "files-incomplete"
  | "needs-human-approval"
  | "invalid-arguments"
  | "policy-invalid"
  | "github-error"
  | "merge-failed"
  | "internal-error";

export interface Reason {
  readonly code: ReasonCode;
  readonly detail: string;
}

/** `type` is GitHub's GraphQL __typename: "User", "Bot", "Mannequin", ... */
export interface Actor {
  readonly login: string;
  readonly type: string;
}

export type ReviewState =
  | "PENDING"
  | "COMMENTED"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "DISMISSED";

export interface Review {
  readonly author: Actor | null;
  readonly authorAssociation: string;
  readonly state: ReviewState;
  readonly commit: string | null;
}

export interface ChangedFile {
  readonly path: string;
  readonly previousPath: string | null;
}

/** watch-pr's snapshot, plus the open PR whose head reports no checks at all (watch-pr throws there). */
export type Readiness =
  | W.PrSnapshot
  | {
      readonly kind: "no-checks";
      readonly context: W.PrContext;
      readonly facts: W.PullRequestFacts;
      readonly threads: readonly W.ReviewThread[];
    };

export interface PrFacts {
  /** Canonical owner/name as GitHub reports it. */
  readonly pr: W.PrContext;
  /** Head read alongside `reviews`; `readiness.facts.headRefOid` is a second, later read. */
  readonly head: string;
  /** The PR's base branch and the repo's default branch; null when GitHub reports none. */
  readonly base: string | null;
  readonly defaultBranch: string | null;
  readonly author: Actor | null;
  readonly reviews: readonly Review[];
  readonly reviewThreadCount: number;
  readonly reviewCount: number;
  readonly changedFileCount: number;
  readonly files: readonly ChangedFile[];
  readonly readiness: Readiness;
}

export type MergeMethod = "squash" | "merge";

export type Decision =
  | { readonly kind: "merge"; readonly method: MergeMethod }
  | { readonly kind: "refuse"; readonly reasons: W.NonEmpty<Reason> };

/** watch-pr reads the first 100 review threads and does not paginate. */
export const THREAD_PAGE_SIZE = 100;
/** The gate's own query reads the last 100 reviews. */
export const REVIEW_PAGE_SIZE = 100;
const MERGEABLE_STATES: ReadonlySet<W.MergeStateStatus> = new Set([
  "CLEAN",
  "HAS_HOOKS",
]);
const WRITE_ACCESS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);
type Stance = Review & { readonly author: Actor };
const STANCES: ReadonlySet<ReviewState> = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
]);
const CHECK_OUTCOME: Record<W.Check["kind"], "ok" | "failed" | "pending"> = {
  passed: "ok",
  skipped: "ok",
  failed: "failed",
  pending: "pending",
  "code-review-gate": "pending",
};

const reason = (code: ReasonCode, detail: string): Reason => ({ code, detail });

export function decide(policy: Policy, facts: PrFacts, viewer: string): Decision {
  const repo = repoPolicy(policy, facts.pr);
  const stances = latestStances(facts.reviews);
  if (repo === null)
    return {
      kind: "refuse",
      reasons: [
        reason(
          "repo-not-allowed",
          `${facts.pr.owner}/${facts.pr.repo} matches no repos entry in the merge policy`
        ),
        ...pullRequestReasons(facts, viewer, stances),
      ],
    };
  const reasons = nonEmpty([
    ...pullRequestReasons(facts, viewer, stances),
    ...approvalReasons(repo, facts, stances),
  ]);
  if (reasons !== null) return { kind: "refuse", reasons };
  const branch = facts.readiness.facts.headRefName;
  return {
    kind: "merge",
    method: repo.mergeCommitBranches.some((glob) => new Bun.Glob(glob).match(branch))
      ? "merge"
      : "squash",
  };
}

// GitHub lists reviews oldest first, so the last stance per reviewer is their
// current one: an approval later dismissed or followed by a change request no
// longer counts, and a change request later approved or dismissed is lifted.
function latestStances(reviews: readonly Review[]): readonly Stance[] {
  const stances = new Map<string, Stance>();
  for (const review of reviews)
    if (review.author !== null && STANCES.has(review.state))
      stances.set(review.author.login, { ...review, author: review.author });
  return [...stances.values()];
}

function pullRequestReasons(
  facts: PrFacts,
  viewer: string,
  stances: readonly Stance[]
): Reason[] {
  const { readiness } = facts;
  const pr = readiness.facts;
  const reasons: Reason[] = [];
  if (readiness.kind === "merged" || readiness.kind === "closed")
    reasons.push(reason("not-open", `PR is ${readiness.kind}`));
  if (pr.isDraft) reasons.push(reason("draft", "PR is a draft"));
  if (facts.author?.login !== viewer)
    reasons.push(
      reason(
        "not-author",
        `PR author is ${facts.author?.login ?? "unknown"}, gh is authenticated as ${viewer}`
      )
    );
  if (facts.base === null || facts.base !== facts.defaultBranch)
    reasons.push(
      reason(
        "base-not-trunk",
        `base is ${facts.base ?? "unknown"}, the default branch is ${facts.defaultBranch ?? "unknown"}`
      )
    );
  reasons.push(...changesRequestedReasons(pr.reviewDecision, stances));
  if (readiness.kind === "open" || readiness.kind === "no-checks")
    reasons.push(
      ...readinessReasons(pr, readiness.threads, readiness.kind === "open" ? readiness.ci : null)
    );
  if (facts.reviewThreadCount > THREAD_PAGE_SIZE)
    reasons.push(
      reason(
        "threads-unverified",
        `${facts.reviewThreadCount} review threads exceed the ${THREAD_PAGE_SIZE} that can be checked`
      )
    );
  if (facts.reviewCount > REVIEW_PAGE_SIZE)
    reasons.push(
      reason(
        "reviews-unverified",
        `${facts.reviewCount} reviews exceed the ${REVIEW_PAGE_SIZE} that can be checked for requested changes`
      )
    );
  if (pr.headRefOid !== facts.head)
    reasons.push(
      reason("head-moved", `head was ${facts.head}, then ${pr.headRefOid ?? "unknown"}`)
    );
  return reasons;
}

function readinessReasons(
  pr: W.PullRequestFacts,
  threads: readonly W.ReviewThread[],
  ci: W.CiState | null
): Reason[] {
  const reasons: Reason[] = [];
  if (pr.mergeable !== "MERGEABLE" || !MERGEABLE_STATES.has(pr.mergeStateStatus))
    reasons.push(
      reason(
        "not-mergeable",
        `GitHub reports mergeable=${pr.mergeable}, mergeStateStatus=${pr.mergeStateStatus}`
      )
    );
  reasons.push(...checkReasons(ci));
  if (threads.length > 0)
    reasons.push(
      reason(
        "threads-unresolved",
        `${threads.length} unresolved review thread(s): ${threads.map((thread) => thread.id).join(", ")}`
      )
    );
  return reasons;
}

// reviewDecision is null on repos without required reviews, so each
// reviewer's own latest stance blocks too, whoever they are.
function changesRequestedReasons(
  reviewDecision: W.PullRequestFacts["reviewDecision"],
  stances: readonly Stance[]
): Reason[] {
  const requesters = stances
    .filter((stance) => stance.state === "CHANGES_REQUESTED")
    .map((stance) => stance.author.login);
  if (requesters.length > 0)
    return [reason("changes-requested", `changes requested by ${requesters.join(", ")}`)];
  if (reviewDecision === "CHANGES_REQUESTED")
    return [reason("changes-requested", "GitHub reports reviewDecision CHANGES_REQUESTED")];
  return [];
}

function checkReasons(ci: W.CiState | null): Reason[] {
  if (ci === null)
    return [reason("checks-missing", "no checks reported on the head commit")];
  const failed = ci.all
    .filter((check) => CHECK_OUTCOME[check.kind] === "failed")
    .map((check) => `${check.name} (${check.reportedState})`);
  if (ci.kind === "ci-github-rejected")
    failed.push(`GitHub head rollup ${ci.github.headRollupState}`);
  const pending = ci.all
    .filter((check) => CHECK_OUTCOME[check.kind] === "pending")
    .map((check) => check.name);
  return [
    ...(failed.length > 0 ? [reason("checks-failed", `failed: ${failed.join(", ")}`)] : []),
    ...(pending.length > 0 ? [reason("checks-pending", `pending: ${pending.join(", ")}`)] : []),
  ];
}

function approvalReasons(
  repo: RepoPolicy,
  facts: PrFacts,
  stances: readonly Stance[]
): Reason[] {
  const reasons: Reason[] = [];
  if (facts.files.length !== facts.changedFileCount)
    reasons.push(
      reason(
        "files-incomplete",
        `read ${facts.files.length} of ${facts.changedFileCount} changed files`
      )
    );
  const globs = repo.humanOnly.map((pattern) => ({ pattern, glob: new Bun.Glob(pattern.toLowerCase()) }));
  const humanOnly = facts.files.flatMap((file) =>
    [file.previousPath, file.path].flatMap((path) => {
      if (path === null) return [];
      const hit = globs.find(({ glob }) => glob.match(path.toLowerCase()));
      return hit === undefined ? [] : [`${path} (${hit.pattern})`];
    })
  );
  const because = [
    ...(repo.requireHumanApprovalOnHead ? ["the policy requires it for this repo"] : []),
    ...(humanOnly.length > 0 ? [`human-only files changed: ${humanOnly.join(", ")}`] : []),
  ];
  if (because.length > 0 && !humanApprovedHead(facts, stances))
    reasons.push(
      reason(
        "needs-human-approval",
        `needs an approval on ${facts.head} from a human collaborator because ${because.join("; ")}`
      )
    );
  return reasons;
}

function humanApprovedHead(facts: PrFacts, stances: readonly Stance[]): boolean {
  return stances.some(
    (review) =>
      review.state === "APPROVED" &&
      review.commit === facts.head &&
      review.author.type === "User" &&
      review.author.login !== facts.author?.login &&
      WRITE_ACCESS.has(review.authorAssociation)
  );
}
