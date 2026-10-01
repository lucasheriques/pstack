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
  type Comment,
  type Decision,
  type PrFacts,
  type Readiness,
  type Review,
  attestationMarker,
  decide,
} from "./decide.ts";
import { parsePolicy } from "./policy.ts";

const HEAD = "1111111111111111111111111111111111111111";
const OLD = "0000000000000000000000000000000000000000";

const policy = parsePolicy({
  defaults: { humanOnly: [".github/**", "**/migrations/**"] },
  repos: {
    "acme/app": {
      humanOnly: ["billing/**"],
      mergeCommitBranches: ["sync/*"],
      reviewSubstitutes: ["claude-review"],
    },
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
  return decide(
    policy,
    {
      pr: context,
      head: HEAD,
      base: "main",
      defaultBranch: "main",
      author: { login: "agent", type: "User" },
      reviews: [],
      comments: [],
      reviewThreadCount: threads.length,
      reviewCount: 0,
      changedFileCount: files.length,
      files,
      readiness,
      ...scenario.facts,
    },
    scenario.viewer ?? "agent"
  );
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
    expect(run()).toEqual({ kind: "merge", method: "squash", substituted: [] });
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

describe("review substitutes", () => {
  const claudeFailure: FailedCheck = {
    ...details,
    kind: "failed",
    name: "claude-review",
    reportedState: "FAILURE",
  };
  const onlyClaudeFailed: CiState = {
    ...failing,
    all: [passingCheck("lint"), claudeFailure],
    failed: [claudeFailure],
  };
  const attestation = (
    head: string,
    author = "agent",
    verdict: "clean" | "blockers" = "clean",
    type = "User"
  ): Comment => ({ author: { login: author, type }, body: attestationMarker(head, verdict) });
  const unstable = { mergeStateStatus: "UNSTABLE" as const };

  it.each<[string, Scenario, readonly string[]]>([
    [
      "a failed reviewer check with an attestation on the head",
      { ci: onlyClaudeFailed, pr: unstable, facts: { comments: [attestation(HEAD)] } },
      ["merge:squash"],
    ],
    [
      "a failed reviewer check without an attestation",
      { ci: onlyClaudeFailed, pr: unstable },
      ["not-mergeable", "checks-failed"],
    ],
    [
      "an attestation for an older head",
      { ci: onlyClaudeFailed, pr: unstable, facts: { comments: [attestation(OLD)] } },
      ["not-mergeable", "checks-failed"],
    ],
    [
      "an attestation from someone other than the viewer",
      {
        ci: onlyClaudeFailed,
        pr: unstable,
        facts: { comments: [attestation(HEAD, "stranger")] },
      },
      ["not-mergeable", "checks-failed"],
    ],
    [
      "an attestation while another check also failed",
      {
        ci: { ...failing, all: [claudeFailure, testFailure], failed: [claudeFailure, testFailure] },
        pr: unstable,
        facts: { comments: [attestation(HEAD)] },
      },
      ["not-mergeable", "checks-failed"],
    ],
    [
      "an attestation for a check the policy does not list",
      { ci: failing, pr: unstable, facts: { comments: [attestation(HEAD)] } },
      ["not-mergeable", "checks-failed"],
    ],
    [
      "an attestation while a check is still pending",
      {
        ci: { ...onlyClaudeFailed, pending: [e2ePending], all: [claudeFailure, e2ePending] },
        pr: unstable,
        facts: { comments: [attestation(HEAD)] },
      },
      ["checks-pending"],
    ],
    [
      "an attestation while review threads are unresolved",
      {
        ci: onlyClaudeFailed,
        pr: unstable,
        threads: [thread],
        facts: { comments: [attestation(HEAD)] },
      },
      ["threads-unresolved"],
    ],
  ])("%s", (_name, scenario, expected) => {
    expect(codes(run(scenario))).toEqual(expected);
  });

  it.each<[string, Scenario, readonly string[]]>([
    [
      "a later blockers marker revokes a clean one",
      {
        ci: onlyClaudeFailed,
        pr: unstable,
        facts: { comments: [attestation(HEAD), attestation(HEAD, "agent", "blockers")] },
      },
      ["not-mergeable", "checks-failed"],
    ],
    [
      "a clean marker after a blockers one restores it",
      {
        ci: onlyClaudeFailed,
        pr: unstable,
        facts: { comments: [attestation(HEAD, "agent", "blockers"), attestation(HEAD)] },
      },
      ["merge:squash"],
    ],
    [
      "a marker quoted inside other text",
      {
        ci: onlyClaudeFailed,
        pr: unstable,
        facts: {
          comments: [
            { author: { login: "agent", type: "User" }, body: `will post ${attestationMarker(HEAD)} later` },
          ],
        },
      },
      ["not-mergeable", "checks-failed"],
    ],
    [
      "a bot that shares the viewer's login",
      {
        ci: onlyClaudeFailed,
        pr: unstable,
        facts: { comments: [attestation(HEAD, "agent", "clean", "Bot")] },
      },
      ["not-mergeable", "checks-failed"],
    ],
    [
      "a required reviewer check, which leaves GitHub BLOCKED",
      {
        ci: onlyClaudeFailed,
        pr: { mergeStateStatus: "BLOCKED" },
        facts: { comments: [attestation(HEAD)] },
      },
      ["not-mergeable"],
    ],
    [
      "the head moving after the attestation",
      {
        ci: onlyClaudeFailed,
        pr: { ...unstable, headRefOid: OLD },
        facts: { comments: [attestation(HEAD)] },
      },
      ["head-moved"],
    ],
  ])("%s", (_name, scenario, expected) => {
    expect(codes(run(scenario))).toEqual(expected);
  });

  it("records which failed checks the attestation replaced", () => {
    expect(
      run({ ci: onlyClaudeFailed, pr: unstable, facts: { comments: [attestation(HEAD)] } })
    ).toEqual({ kind: "merge", method: "squash", substituted: ["claude-review"] });
  });
});
