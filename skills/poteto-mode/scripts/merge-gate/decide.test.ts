import { describe, expect, it } from "bun:test";
import { passingCheck } from "../watch-pr/fakes.test-helper.ts";
import type {
  Check,
  CiState,
  FailedCheck,
  PendingCheck,
  PullRequestFacts,
  ReviewThread,
} from "../watch-pr/types.ts";
import { parsePrNumber } from "../watch-pr/types.ts";
import {
  type Decision,
  type ExpectedBase,
  type NativeStack,
  type PrFacts,
  type Readiness,
  type ReasonCode,
  type Review,
  type StackEntry,
  TRUNK,
  decide,
  decidePlan,
  planStack,
} from "./decide.ts";
import { parsePolicy } from "./policy.ts";

const HEAD = "1111111111111111111111111111111111111111";
const OLD = "0000000000000000000000000000000000000000";

const policy = parsePolicy({
  defaults: { humanOnly: [".github/**", "**/migrations/**"] },
  repos: {
    "acme/app": { humanOnly: ["billing/**"], mergeCommitBranches: ["sync/*"] },
    "acme/*": {},
    "strict/lenient": {},
    "strict/*": { requireHumanApprovalOnHead: true },
  },
});

const details = { description: "", link: "", workflow: "" };
const testFailure: FailedCheck = { ...details, kind: "failed", name: "test", reportedState: "FAILURE" };
const e2ePending: PendingCheck = { ...details, kind: "pending", name: "e2e", reportedState: "PENDING" };

const clean = (checks: readonly [Check, ...Check[]]): CiState => ({
  kind: "ci-clean",
  source: "gh-pr-checks",
  all: checks,
  failed: [],
  pending: [],
  hadPreviousPassingCi: false,
  github: {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: "CLEAN",
    headRollupState: "SUCCESS",
  },
});

const failing: CiState = {
  kind: "ci-failing",
  source: "gh-pr-checks",
  all: [passingCheck("lint"), testFailure],
  failed: [testFailure],
  pending: [],
  hadPreviousPassingCi: false,
  github: {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: "CLEAN",
    headRollupState: "FAILURE",
  },
};

const rejected: CiState = {
  kind: "ci-github-rejected",
  source: "gh-pr-checks",
  all: [passingCheck()],
  failed: [],
  pending: [],
  hadPreviousPassingCi: false,
  github: {
    kind: "refused",
    mergeStateStatus: "BLOCKED",
    headRollupState: "FAILURE",
  },
};

const pending: CiState = {
  kind: "ci-pending",
  source: "gh-pr-checks",
  all: [passingCheck(), e2ePending],
  failed: [],
  pending: [e2ePending],
  hadPreviousPassingCi: false,
};

const reviewGate: Check = {
  ...details,
  kind: "code-review-gate",
  name: "Code Review Gate",
  reportedState: "PENDING",
};

const thread: ReviewThread = {
  id: "T1",
  firstComment: null,
  isBugbot: false,
  bugbotReviewPasses: 0,
};

interface Scenario {
  readonly repo?: string;
  readonly viewer?: string;
  readonly facts?: Partial<Omit<PrFacts, "pr" | "readiness">>;
  readonly pr?: Partial<Omit<PullRequestFacts, "context">>;
  readonly readiness?: "open" | "closed" | "merged" | "no-checks";
  readonly ci?: CiState;
  readonly threads?: readonly ReviewThread[];
  readonly paths?: readonly string[];
  readonly base?: ExpectedBase;
}

function run(scenario: Scenario = {}): Decision {
  const [owner, repo] = (scenario.repo ?? "acme/app").split("/");
  const context = { owner, repo, number: parsePrNumber(7) };
  const facts: PullRequestFacts = {
    context,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    headRefOid: HEAD,
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
    ...scenario.pr,
  };
  const kind = scenario.readiness ?? "open";
  const threads = scenario.threads ?? [];
  const readiness: Readiness =
    kind === "open"
      ? {
          kind,
          context,
          facts,
          threads,
          ci: scenario.ci ?? clean([passingCheck()]),
          reviewAutomationRunning: false,
        }
      : kind === "no-checks"
        ? { kind, context, facts, threads }
        : { kind, context, facts };
  const files = (scenario.paths ?? ["src/index.ts"]).map((path) => ({
    path,
    previousPath: null,
  }));
  const prFacts: PrFacts = {
    pr: context,
    head: HEAD,
    base: "main",
    defaultBranch: "main",
    stack: null,
    author: { login: "agent", type: "User" },
    reviews: [],
    reviewThreadCount: threads.length,
    reviewCount: 0,
    changedFileCount: files.length,
    files,
    readiness,
    ...scenario.facts,
  };
  return decide(policy, prFacts, scenario.viewer ?? "agent", scenario.base ?? TRUNK);
}

const codes = (decision: Decision): readonly string[] =>
  decision.kind === "refuse"
    ? decision.reasons.map((reason) => reason.code)
    : [`merge:${decision.method}`];

function review(overrides: Partial<Review> = {}): Review {
  return {
    author: { login: "human", type: "User" },
    authorAssociation: "MEMBER",
    state: "APPROVED",
    commit: HEAD,
    ...overrides,
  };
}

describe("decide", () => {
  it("merges an all-clear PR by squash", () => {
    expect(run()).toEqual({ kind: "merge", method: "squash" });
  });

  it.each<[string, Scenario, readonly string[]]>([
    ["unlisted repo", { repo: "other/app" }, ["repo-not-allowed"]],
    ["closed PR", { readiness: "closed", pr: { state: "CLOSED" } }, ["not-open"]],
    ["merged PR", { readiness: "merged", pr: { state: "MERGED" } }, ["not-open"]],
    ["draft", { pr: { isDraft: true } }, ["draft"]],
    ["someone else's PR", { viewer: "other" }, ["not-author"]],
    ["deleted author", { facts: { author: null } }, ["not-author"]],
    ["conflicts", { pr: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } }, ["not-mergeable"]],
    ["mergeability still computing", { pr: { mergeable: "UNKNOWN" } }, ["not-mergeable"]],
    ["branch protection blocks", { pr: { mergeStateStatus: "BLOCKED" } }, ["not-mergeable"]],
    ["behind base", { pr: { mergeStateStatus: "BEHIND" } }, ["not-mergeable"]],
    ["unstable status", { pr: { mergeStateStatus: "UNSTABLE" } }, ["not-mergeable"]],
    ["changes requested", { pr: { reviewDecision: "CHANGES_REQUESTED" } }, ["changes-requested"]],
    ["base is not the default branch", { facts: { base: "release" } }, ["base-not-trunk"]],
    ["base unknown", { facts: { base: null } }, ["base-not-trunk"]],
    ["default branch unknown", { facts: { defaultBranch: null } }, ["base-not-trunk"]],
    ["failed check", { ci: failing }, ["checks-failed"]],
    ["GitHub rejects the head rollup", { ci: rejected, pr: { mergeStateStatus: "BLOCKED" } }, ["not-mergeable", "checks-failed"]],
    ["pending check", { ci: pending }, ["checks-pending"]],
    ["code review gate still waiting", { ci: clean([passingCheck(), reviewGate]) }, ["checks-pending"]],
    ["no checks on head", { readiness: "no-checks" }, ["checks-missing"]],
    ["unresolved thread", { threads: [thread] }, ["threads-unresolved"]],
    ["more threads than one page", { facts: { reviewThreadCount: 101 } }, ["threads-unverified"]],
    ["more reviews than one page", { facts: { reviewCount: 101 } }, ["reviews-unverified"]],
    ["head moved between reads", { pr: { headRefOid: OLD } }, ["head-moved"]],
    ["file list truncated", { facts: { changedFileCount: 3001 } }, ["files-incomplete"]],
    ["repo requires approval", { repo: "strict/app" }, ["needs-human-approval"]],
    ["default human-only glob", { paths: [".github/workflows/ci.yml"] }, ["needs-human-approval"]],
  ])("refuses on %s", (_name, scenario, expected) => {
    expect(codes(run(scenario))).toEqual(expected);
  });

  it("collects every failing reason at once", () => {
    const decision = run({
      repo: "strict/app",
      viewer: "other",
      pr: { isDraft: true, mergeable: "CONFLICTING" },
      ci: pending,
      threads: [thread],
    });
    expect(codes(decision)).toEqual([
      "draft",
      "not-author",
      "not-mergeable",
      "checks-pending",
      "threads-unresolved",
      "needs-human-approval",
    ]);
  });

  it("names the failing and pending checks", () => {
    const decision = run({
      ci: { ...failing, all: [testFailure, e2ePending] },
    });
    expect(decision).toEqual({
      kind: "refuse",
      reasons: [
        { code: "checks-failed", detail: "failed: test (FAILURE)" },
        { code: "checks-pending", detail: "pending: e2e" },
      ],
    });
  });
});

describe("human-only globs", () => {
  it.each<[string, string, readonly string[]]>([
    ["acme/app", "billing/invoice.ts", ["needs-human-approval"]],
    ["acme/other", "billing/invoice.ts", ["merge:squash"]],
    ["acme/app", ".github/workflows/ci.yml", ["needs-human-approval"]],
    ["acme/other", ".github/workflows/ci.yml", ["needs-human-approval"]],
    ["acme/other", "db/migrations/001.sql", ["needs-human-approval"]],
    ["acme/other", "db/Migrations/001.sql", ["needs-human-approval"]],
    ["ACME/App", "billing/invoice.ts", ["needs-human-approval"]],
    ["strict/lenient", "src/index.ts", ["needs-human-approval"]],
    ["strict/other", "src/index.ts", ["needs-human-approval"]],
  ])("%s changing %s", (repo, path, expected) => {
    expect(codes(run({ repo, paths: [path] }))).toEqual(expected);
  });

  it("reports every matching file, including a rename's old path", () => {
    const decision = run({
      facts: {
        changedFileCount: 3,
        files: [
          { path: "src/index.ts", previousPath: null },
          { path: "billing/invoice.ts", previousPath: null },
          { path: "docs/ci.yml", previousPath: ".github/workflows/ci.yml" },
        ],
      },
    });
    expect(decision).toEqual({
      kind: "refuse",
      reasons: [
        {
          code: "needs-human-approval",
          detail: `needs an approval on ${HEAD} from a human collaborator because human-only files changed: billing/invoice.ts (billing/**), .github/workflows/ci.yml (.github/**)`,
        },
      ],
    });
  });
});

describe("human approval on head", () => {
  it.each<[string, readonly Review[], readonly string[]]>([
    ["collaborator approved head", [review()], ["merge:squash"]],
    ["owner approved head", [review({ authorAssociation: "OWNER" })], ["merge:squash"]],
    ["bot approved head", [review({ author: { login: "ci-bot", type: "Bot" } })], ["needs-human-approval"]],
    ["approval on an old head", [review({ commit: OLD })], ["needs-human-approval"]],
    ["author approved own PR", [review({ author: { login: "agent", type: "User" } })], ["needs-human-approval"]],
    ["drive-by approval without write access", [review({ authorAssociation: "NONE" })], ["needs-human-approval"]],
    ["approval later dismissed", [review({ state: "DISMISSED" })], ["needs-human-approval"]],
    ["approval superseded by changes requested", [review(), review({ state: "CHANGES_REQUESTED" })], ["changes-requested", "needs-human-approval"]],
    ["changes requested then approved", [review({ state: "CHANGES_REQUESTED" }), review()], ["merge:squash"]],
    ["approval followed by a comment", [review(), review({ state: "COMMENTED" })], ["merge:squash"]],
    ["deleted reviewer", [review({ author: null })], ["needs-human-approval"]],
  ])("%s", (_name, reviews, expected) => {
    expect(codes(run({ repo: "strict/app", facts: { reviews } }))).toEqual(expected);
  });
});

describe("changes requested", () => {
  it.each<[string, readonly Review[], readonly string[]]>([
    ["collaborator requested changes", [review({ state: "CHANGES_REQUESTED" })], ["changes-requested"]],
    ["bot requested changes", [review({ state: "CHANGES_REQUESTED", author: { login: "ci-bot", type: "Bot" } })], ["changes-requested"]],
    ["reviewer without write access requested changes", [review({ state: "CHANGES_REQUESTED", authorAssociation: "NONE" })], ["changes-requested"]],
    ["request on an old head", [review({ state: "CHANGES_REQUESTED", commit: OLD })], ["changes-requested"]],
    ["request followed by a comment", [review({ state: "CHANGES_REQUESTED" }), review({ state: "COMMENTED" })], ["changes-requested"]],
    ["request later approved", [review({ state: "CHANGES_REQUESTED" }), review()], ["merge:squash"]],
    ["request later dismissed", [review({ state: "CHANGES_REQUESTED" }), review({ state: "DISMISSED" })], ["merge:squash"]],
    [
      "one reviewer approved, another requested changes",
      [review({ state: "CHANGES_REQUESTED", author: { login: "other", type: "User" } }), review()],
      ["changes-requested"],
    ],
  ])("%s with no reviewDecision", (_name, reviews, expected) => {
    expect(codes(run({ facts: { reviews } }))).toEqual(expected);
  });

  it("names every reviewer whose latest stance requests changes", () => {
    const decision = run({
      facts: {
        reviews: [
          review({ state: "CHANGES_REQUESTED", author: { login: "ci-bot", type: "Bot" } }),
          review({ state: "CHANGES_REQUESTED" }),
          review({ state: "CHANGES_REQUESTED", author: { login: "fixed", type: "User" } }),
          review({ author: { login: "fixed", type: "User" } }),
        ],
      },
    });
    expect(decision).toEqual({
      kind: "refuse",
      reasons: [{ code: "changes-requested", detail: "changes requested by ci-bot, human" }],
    });
  });
});

describe("merge method", () => {
  it.each<[string, string, readonly string[]]>([
    ["acme/app", "sync/upstream", ["merge:merge"]],
    ["acme/app", "sync/a/b", ["merge:squash"]],
    ["acme/app", "feature", ["merge:squash"]],
    ["acme/other", "sync/upstream", ["merge:squash"]],
  ])("%s head %s", (repo, headRefName, expected) => {
    expect(codes(run({ repo, pr: { headRefName } }))).toEqual(expected);
  });
});

describe("expected base", () => {
  const below: ExpectedBase = { kind: "below", number: parsePrNumber(6), branch: "feature-6" };
  it.each<[string, Scenario, Decision]>([
    ["accepts a stacked PR whose base is the head below it", { facts: { base: "feature-6" }, base: below }, { kind: "merge", method: "squash" }],
    [
      "refuses a stacked PR whose base is not the head below it",
      { facts: { base: "feature-5" }, base: below },
      { kind: "refuse", reasons: [{ code: "base-not-trunk", detail: "base is feature-5, the head of #6 below it is feature-6" }] },
    ],
    [
      "refuses trunk when the head below it is expected",
      { base: below },
      { kind: "refuse", reasons: [{ code: "base-not-trunk", detail: "base is main, the head of #6 below it is feature-6" }] },
    ],
    [
      "names the default branch for a plain PR",
      { facts: { base: "release" } },
      { kind: "refuse", reasons: [{ code: "base-not-trunk", detail: "base is release, the default branch is main" }] },
    ],
  ])("%s", (_name, scenario, expected) => {
    expect(run(scenario)).toEqual(expected);
  });
});

/** Stack fixtures put PR #(position + 4) at each position, on branch feature-(number). */
const prAt = (position: number) => parsePrNumber(position + 4);
const entry = (position: number, state: StackEntry["state"] = "OPEN"): StackEntry => ({
  position,
  number: prAt(position),
  state,
  headRefName: `feature-${prAt(position)}`,
});
const onTop = (position: number): ExpectedBase => ({ kind: "below", number: prAt(position), branch: `feature-${prAt(position)}` });

describe("planStack", () => {
  const stack = (states: readonly StackEntry["state"][]): NativeStack => ({
    number: 42,
    below: states.slice(0, -1).map((state, index) => entry(index + 1, state)),
    target: entry(states.length, states.at(-1)),
  });
  it.each<{ name: string; states: readonly StackEntry["state"][]; below: readonly [number, ExpectedBase][]; top: ExpectedBase; reasons: readonly string[] }>([
    {
      name: "gates every PR below the target, each against the head below it",
      states: ["OPEN", "OPEN", "OPEN"],
      below: [[1, TRUNK], [2, onTop(1)]],
      top: onTop(2),
      reasons: [],
    },
    {
      name: "skips a merged lower entry and expects trunk under the lowest open one",
      states: ["MERGED", "OPEN", "OPEN"],
      below: [[2, TRUNK]],
      top: onTop(2),
      reasons: [],
    },
    { name: "gates a target at position 1 alone", states: ["OPEN"], below: [], top: TRUNK, reasons: [] },
    {
      name: "refuses a closed lower entry",
      states: ["CLOSED", "OPEN", "OPEN"],
      below: [[2, TRUNK]],
      top: onTop(2),
      reasons: ["#5: PR is closed"],
    },
    { name: "refuses a merged target", states: ["MERGED", "MERGED"], below: [], top: TRUNK, reasons: ["#6: PR is merged"] },
  ])("$name", ({ states, below, top, reasons }) => {
    expect(planStack(stack(states))).toEqual({
      plan: {
        stack: 42,
        below: below.map(([position, base]) => ({ number: prAt(position), base })),
        top: { number: prAt(states.length), base: top },
      },
      reasons: reasons.map((detail) => ({ code: "not-open", detail })),
    });
  });
});

describe("decidePlan", () => {
  const gated = (position: number, base: ExpectedBase, facts: Partial<PrFacts> = {}) => ({
    base,
    facts: {
      pr: { owner: "acme", repo: "app", number: prAt(position) },
      head: HEAD,
      base: base.kind === "trunk" ? "main" : base.branch,
      defaultBranch: "main",
      stack: 42,
      author: { login: "agent", type: "User" },
      reviews: [],
      reviewThreadCount: 0,
      reviewCount: 0,
      changedFileCount: 1,
      files: [{ path: "src/index.ts", previousPath: null }],
      readiness: {
        kind: "open",
        context: { owner: "acme", repo: "app", number: prAt(position) },
        facts: {
          context: { owner: "acme", repo: "app", number: prAt(position) },
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          headRefOid: HEAD,
          headRefName: `feature-${prAt(position)}`,
          baseRefName: base.kind === "trunk" ? "main" : base.branch,
          state: "OPEN",
          mergedAt: null,
          isDraft: false,
        },
        threads: [],
        ci: clean([passingCheck()]),
        reviewAutomationRunning: false,
      },
      ...facts,
    } satisfies PrFacts,
  });
  it.each<{ name: string; stack: number | null; below: readonly ReturnType<typeof gated>[]; top: ReturnType<typeof gated>; expected: Decision }>([
    {
      name: "merges a stack whose every PR passes",
      stack: 42,
      below: [gated(1, TRUNK), gated(2, onTop(1))],
      top: gated(3, onTop(2)),
      expected: { kind: "merge", method: "squash" },
    },
    {
      name: "tags each refusal with its PR in a stack",
      stack: 42,
      below: [gated(1, TRUNK, { base: "release" }), gated(2, onTop(1))],
      top: gated(3, onTop(2), { base: "feature-5" }),
      expected: {
        kind: "refuse",
        reasons: [
          { code: "base-not-trunk", detail: "#5: base is release, the default branch is main" },
          { code: "base-not-trunk", detail: "#7: base is feature-5, the head of #6 below it is feature-6" },
        ],
      },
    },
    {
      name: "points a plain run on a stacked PR at --stack",
      stack: null,
      below: [],
      top: gated(3, TRUNK, { base: "feature-6" }),
      expected: {
        kind: "refuse",
        reasons: [
          {
            code: "base-not-trunk",
            detail:
              "base is feature-6, the default branch is main; PR is in native stack #42, so rerun with --stack to gate it with the PRs below it",
          },
        ],
      },
    },
    {
      name: "gives no hint for a plain PR outside a stack",
      stack: null,
      below: [],
      top: gated(3, TRUNK, { base: "release", stack: null }),
      expected: { kind: "refuse", reasons: [{ code: "base-not-trunk", detail: "base is release, the default branch is main" }] },
    },
  ])("$name", ({ stack, below, top, expected }) => {
    expect(decidePlan(policy, "agent", stack, below, top)).toEqual(expected);
  });
});
