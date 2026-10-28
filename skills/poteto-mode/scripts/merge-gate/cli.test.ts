import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Verdict, main } from "./cli.ts";
import type { ReasonCode } from "./decide.ts";
import { type FakeGh, type FakeResponse, type FakeRule, fakeGh } from "./fake-gh.test-helper.ts";

const LAUNCHER = join(import.meta.dir, "merge-gate");
const HEAD = "1111111111111111111111111111111111111111";
const MOVED = "2222222222222222222222222222222222222222";
const MERGE_COMMIT = "3333333333333333333333333333333333333333";
const JOB = "c0ffee00-0000-4000-8000-000000000000";
const STACKED = {
  stderr: "GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API (mergePullRequest)\n",
  exit: 1,
};
const POLICY = {
  defaults: { humanOnly: [".github/**"] },
  repos: { "acme/app": { mergeCommitBranches: ["sync/*"] } },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface PrFixture {
  readonly head?: string;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly isDraft?: boolean;
  readonly viewHeads?: readonly string[];
  readonly checks?: "passing" | "pending" | "none";
  readonly outcome?: FakeRule[1];
  readonly defaultBranch?: string | null;
  readonly stack?: number | null;
}

interface Scenario extends PrFixture {
  readonly user?: FakeRule[1];
  readonly merge?: FakeRule[1];
  readonly asyncMerge?: FakeRule[1];
  readonly asyncPolls?: FakeRule[1];
  /** Contents of $HOME/.claude/pstack/merge-policy.json; null leaves it absent. */
  readonly policy?: string | null;
}

const outcome = (state: string, mergeCommit: string | null): FakeResponse => ({
  stdout: {
    data: {
      repository: {
        pullRequest: {
          state,
          mergedAt: state === "MERGED" ? "2026-09-24T00:00:00Z" : null,
          mergeCommit: mergeCommit === null ? null : { oid: mergeCommit },
        },
      },
    },
  },
});

const CHECKS = {
  passing: { name: "test", state: "SUCCESS", bucket: "pass", rollup: "SUCCESS" },
  pending: { name: "e2e", state: "PENDING", bucket: "pending", rollup: "PENDING" },
} as const;

function prRules(number: number, pr: PrFixture): FakeRule[] {
  const head = pr.head ?? HEAD;
  const view = (viewHead: string) => ({
    stdout: {
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      headRefOid: viewHead,
      headRefName: pr.headRefName ?? "feature",
      baseRefName: pr.baseRefName ?? "main",
      state: "OPEN",
      mergedAt: null,
      isDraft: pr.isDraft ?? false,
    },
  });
  const pullRequest = (value: unknown) => ({
    stdout: { data: { repository: { pullRequest: value } } },
  });
  const graphql = (query: string): readonly string[] => [`query ${query}`, `pr=${number}`];
  const checks = pr.checks === "none" ? null : CHECKS[pr.checks ?? "passing"];
  return [
    [
      graphql("MergeGatePr"),
      [
        {
          stdout: {
            data: {
              repository: {
                nameWithOwner: "acme/app",
                defaultBranchRef: pr.defaultBranch === null ? null : { name: pr.defaultBranch ?? "main" },
                pullRequest: {
                  headRefOid: head,
                  baseRefName: pr.baseRefName ?? "main",
                  stack: pr.stack === undefined || pr.stack === null ? null : { number: pr.stack },
                  changedFiles: 1,
                  author: { __typename: "User", login: "agent" },
                  reviewThreads: { totalCount: 0 },
                  reviews: { totalCount: 0, nodes: [] },
                },
              },
            },
          },
        },
      ],
    ],
    [`repos/acme/app/pulls/${number}/files`, [{ stdout: [{ filename: "src/index.ts" }] }]],
    [`pr view ${number} --repo acme/app`, (pr.viewHeads ?? [head]).map(view)],
    [
      `pr checks ${number}`,
      checks === null
        ? [{ stderr: "no checks reported on the 'feature' branch\n", exit: 1 }]
        : [
            {
              stdout: [
                { name: checks.name, state: checks.state, description: "", link: "", workflow: "ci", bucket: checks.bucket },
              ],
            },
          ],
    ],
    [graphql("PrCheckRollup"), [pullRequest({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })]],
    [graphql("ReviewThreads"), [pullRequest({ reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })]],
    [
      graphql("PrCommitStatuses"),
      [pullRequest({ commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { state: checks?.rollup ?? "SUCCESS" } } }] } })],
    ],
    [graphql("MergeGateOutcome"), pr.outcome ?? [outcome("MERGED", MERGE_COMMIT)]],
  ];
}

/** Stack fixtures put PR #(position + 4) at each position, on branch feature-(number). */
const prAt = (position: number): number => position + 4;
type EntryState = "OPEN" | "CLOSED" | "MERGED";

const stackPage = (states: readonly EntryState[], { from = 1, cursor = null as string | null } = {}): FakeResponse => ({
  stdout: {
    data: {
      repository: {
        pullRequest: {
          stack: {
            number: 42,
            entries: {
              pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
              nodes: states.map((state, index) => ({
                position: from + index,
                pullRequest: { number: prAt(from + index), state, headRefName: `feature-${prAt(from + index)}` },
              })),
            },
          },
        },
      },
    },
  },
});
const NOT_STACKED: FakeResponse = { stdout: { data: { repository: { pullRequest: { stack: null } } } } };

function rules(scenario: Scenario = {}): readonly FakeRule[] {
  return [
    ["api user", scenario.user ?? [{ stdout: { login: "agent" } }]],
    ...prRules(7, scenario),
    ["pr merge 7", scenario.merge ?? [{ stdout: "" }]],
    [`pulls/7/merge-async/${JOB}`, scenario.asyncPolls ?? [{ stdout: { status: "merged", details: { uuid: JOB } } }]],
    ["pulls/7/merge-async", scenario.asyncMerge ?? [{ stdout: { status: "pending", details: { uuid: JOB } } }]],
  ];
}

async function setup(scenario: Scenario = {}, fixture: readonly FakeRule[] = rules(scenario)): Promise<FakeGh> {
  const gh = await fakeGh(fixture);
  cleanups.push(gh.cleanup);
  const policy = scenario.policy === undefined ? JSON.stringify(POLICY) : scenario.policy;
  if (policy !== null)
    await Bun.write(join(gh.directory, ".claude", "pstack", "merge-policy.json"), policy);
  return gh;
}

function runCli(
  gh: FakeGh,
  args: readonly string[],
  cwd?: string
): { readonly exit: number; readonly verdict: Verdict } {
  const result = Bun.spawnSync([process.execPath, LAUNCHER, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: `${gh.bin}:${process.env.PATH ?? ""}`,
      HOME: gh.directory,
    },
  });
  return { exit: result.exitCode, verdict: JSON.parse(result.stdout.toString()) };
}

const withCodes = (verdict: Verdict) => ({
  ...verdict,
  reasons: verdict.reasons.map((reason) => reason.code),
});

const merges = async (gh: FakeGh) =>
  (await gh.calls()).filter((argv) => argv[0] === "pr" && argv[1] === "merge");

const asyncMerges = async (gh: FakeGh) =>
  (await gh.calls()).filter((argv) => argv[0] === "api" && argv[1]?.includes("/merge-async"));

const squash = ["pr", "merge", "7", "--repo", "acme/app", "--match-head-commit", HEAD, "--squash"];
const asyncPut = [
  "api",
  "repos/acme/app/pulls/7/merge-async",
  "-X",
  "PUT",
  "-f",
  `sha=${HEAD}`,
  "-f",
  "merge_method=squash",
  "-f",
  "merge_action=direct_merge",
];
const asyncPoll = ["api", `repos/acme/app/pulls/7/merge-async/${JOB}`];

describe("merge-gate CLI against a fake gh", () => {
  it.each<[string, Scenario, readonly string[], number, object, readonly (readonly string[])[]]>([
    [
      "reports a clear PR as mergeable without merging",
      {},
      ["7", "--repo", "acme/app"],
      0,
      { decision: "merge", merged: false, mergeCommit: null, reasons: [] },
      [],
    ],
    [
      "squash-merges a clear PR pinned to the head it read",
      {},
      ["7", "--repo", "acme/app", "--merge"],
      0,
      { decision: "merge", merged: true, mergeCommit: MERGE_COMMIT, reasons: [] },
      [squash],
    ],
    [
      "accepts a PR URL in place of --repo",
      {},
      ["https://github.com/acme/app/pull/7", "--merge"],
      0,
      { decision: "merge", merged: true, mergeCommit: MERGE_COMMIT, reasons: [] },
      [squash],
    ],
    [
      "uses a merge commit for a mergeCommitBranches head",
      { headRefName: "sync/upstream" },
      ["7", "--repo", "acme/app", "--merge"],
      0,
      { decision: "merge", merged: true, mergeCommit: MERGE_COMMIT, reasons: [] },
      [squash.map((arg) => (arg === "--squash" ? "--merge" : arg))],
    ],
    [
      "refuses when the head moves between the read and the merge",
      { viewHeads: [HEAD, MOVED] },
      ["7", "--repo", "acme/app", "--merge"],
      2,
      { decision: "refuse", merged: false, reasons: ["head-moved"] },
      [],
    ],
    [
      "refuses a draft even with --merge",
      { isDraft: true },
      ["7", "--repo", "acme/app", "--merge"],
      2,
      { decision: "refuse", merged: false, reasons: ["draft"] },
      [],
    ],
    [
      "refuses a head with no checks",
      { checks: "none" },
      ["7", "--repo", "acme/app"],
      2,
      { decision: "refuse", merged: false, reasons: ["checks-missing"] },
      [],
    ],
    [
      "refuses when gh cannot identify the user",
      { user: [{ stderr: "HTTP 401\n", exit: 1 }] },
      ["7", "--repo", "acme/app", "--merge"],
      2,
      { repo: "acme/app", head: null, decision: "refuse", reasons: ["github-error"] },
      [],
    ],
    [
      "refuses a base branch when the repo reports no default branch",
      { defaultBranch: null },
      ["7", "--repo", "acme/app", "--merge"],
      2,
      { decision: "refuse", merged: false, mergeCommit: null, reasons: ["base-not-trunk"] },
      [],
    ],
  ])("%s", async (_name, scenario, args, exit, verdict, expectedMerges) => {
    const gh = await setup(scenario);
    const result = runCli(gh, args);
    expect(result.exit).toBe(exit);
    expect(withCodes(result.verdict)).toMatchObject({ repo: "acme/app", pr: 7, head: HEAD, ...verdict });
    expect(await merges(gh)).toEqual([...expectedMerges]);
  });

  const subject = { repo: "acme/app", pr: 7, head: HEAD, stack: null };
  it.each<[string, Scenario, number, Verdict]>([
    [
      "reports a merge that landed despite a non-zero exit",
      { merge: [{ stderr: "GraphQL: timeout\n", exit: 1 }] },
      0,
      { ...subject, decision: "merge", merged: true, mergeCommit: MERGE_COMMIT, reasons: [] },
    ],
    [
      "refuses a merge GitHub rejected",
      { merge: [{ stderr: "Head branch was modified\nmore detail\n", exit: 1 }], outcome: [outcome("OPEN", null)] },
      2,
      {
        ...subject,
        decision: "refuse",
        merged: false,
        mergeCommit: null,
        reasons: [{ code: "merge-failed", detail: "gh pr merge exited 1: Head branch was modified; PR is OPEN" }],
      },
    ],
    [
      "refuses a merge that exited 0 without landing",
      { outcome: [outcome("OPEN", null)] },
      2,
      {
        ...subject,
        decision: "refuse",
        merged: false,
        mergeCommit: null,
        reasons: [{ code: "merge-failed", detail: "gh pr merge exited 0: no stderr; PR is OPEN" }],
      },
    ],
    [
      "reports an unverified merge when the read-back fails",
      { outcome: [{ stderr: "HTTP 502\n", exit: 1 }] },
      1,
      {
        ...subject,
        decision: "refuse",
        merged: false,
        mergeCommit: null,
        reasons: [
          {
            code: "merge-unverified",
            detail: "gh pr merge exited 0: no stderr, then reading the PR back failed, so it may have merged. Rerun merge-gate without --merge.",
          },
        ],
      },
    ],
  ])("reads the PR back after merging: %s", async (_name, scenario, exit, verdict) => {
    const gh = await setup(scenario);
    const result = runCli(gh, ["7", "--repo", "acme/app", "--merge"]);
    expect(result).toEqual({ exit, verdict });
    expect(await merges(gh)).toEqual([squash]);
    expect(await asyncMerges(gh)).toEqual([]);
  });

  const refused = (code: ReasonCode, detail: string): Verdict => ({
    ...subject,
    decision: "refuse",
    merged: false,
    mergeCommit: null,
    reasons: [{ code, detail }],
  });
  const open = { outcome: [outcome("OPEN", null)] };
  const UNSETTLED = "; PR is OPEN, so it may still merge. Wait for gh pr view to show it settled before rerunning merge-gate --merge.";
  it.each<[string, Scenario, number, Verdict, readonly (readonly string[])[]]>([
    [
      "merges through merge-async pinned to the head it read",
      { merge: [STACKED] },
      0,
      { ...subject, decision: "merge", merged: true, mergeCommit: MERGE_COMMIT, reasons: [] },
      [squash, asyncPut, asyncPoll],
    ],
    [
      "polls merge-async until it settles",
      {
        merge: [STACKED],
        asyncPolls: [{ stdout: { status: "pending", details: { uuid: JOB } } }, { stdout: { status: "merged" } }],
      },
      0,
      { ...subject, decision: "merge", merged: true, mergeCommit: MERGE_COMMIT, reasons: [] },
      [squash, asyncPut, asyncPoll, asyncPoll],
    ],
    [
      "merges a mergeCommitBranches head through merge-async with a merge commit",
      { merge: [STACKED], headRefName: "sync/upstream" },
      0,
      { ...subject, decision: "merge", merged: true, mergeCommit: MERGE_COMMIT, reasons: [] },
      [
        squash.map((arg) => (arg === "--squash" ? "--merge" : arg)),
        asyncPut.map((arg) => (arg === "merge_method=squash" ? "merge_method=merge" : arg)),
        asyncPoll,
      ],
    ],
    [
      "refuses when the merge-async job fails",
      { merge: [STACKED], asyncPolls: [{ stdout: { status: "failed", details: { message: "Merge conflict" } } }], ...open },
      2,
      refused("merge-failed", `merge-async job ${JOB} failed: Merge conflict; PR is OPEN`),
      [squash, asyncPut, asyncPoll],
    ],
    [
      "refuses when the merge-async request itself reports failure",
      { merge: [STACKED], asyncMerge: [{ stdout: { status: "failed", details: { message: "Not mergeable" } } }], ...open },
      2,
      refused("merge-failed", "merge-async failed: Not mergeable; PR is OPEN"),
      [squash, asyncPut],
    ],
    [
      "refuses when GitHub rejects the pinned head",
      {
        merge: [STACKED],
        asyncMerge: [{ stderr: "gh: Head branch was modified. Review and try the merge again. (HTTP 409)\n", exit: 1 }],
        ...open,
      },
      2,
      refused(
        "merge-failed",
        "merge-async request failed: gh api repos/acme/app/pulls/7/merge-async exited 1: gh: Head branch was modified. Review and try the merge again. (HTTP 409); PR is OPEN"
      ),
      [squash, asyncPut],
    ],
    [
      "reports an unverified merge when the merge-async request errors server-side",
      { merge: [STACKED], asyncMerge: [{ stderr: "gh: Bad Gateway (HTTP 502)\n", exit: 1 }], ...open },
      1,
      refused(
        "merge-unverified",
        `merge-async request failed: gh api repos/acme/app/pulls/7/merge-async exited 1: gh: Bad Gateway (HTTP 502)${UNSETTLED}`
      ),
      [squash, asyncPut],
    ],
    [
      "reports an unverified merge when polling merge-async fails",
      { merge: [STACKED], asyncPolls: [{ stderr: "HTTP 502\n", exit: 1 }], ...open },
      1,
      refused(
        "merge-unverified",
        `polling merge-async job ${JOB} failed: gh api repos/acme/app/pulls/7/merge-async/${JOB} exited 1: HTTP 502${UNSETTLED}`
      ),
      [squash, asyncPut, asyncPoll],
    ],
    [
      "reports an unverified merge when the job reports merged but the PR reads open",
      { merge: [STACKED], ...open },
      1,
      refused("merge-unverified", `merge-async job ${JOB} reported merged${UNSETTLED}`),
      [squash, asyncPut, asyncPoll],
    ],
    [
      "reports an unverified merge on a status it does not know",
      { merge: [STACKED], asyncPolls: [{ stdout: { status: "queued" } }], ...open },
      1,
      refused("merge-unverified", `merge-async job ${JOB} reported unknown status queued${UNSETTLED}`),
      [squash, asyncPut, asyncPoll],
    ],
    [
      "reports an unverified merge when merge-async queues a job without a uuid",
      { merge: [STACKED], asyncMerge: [{ stdout: { status: "pending" } }], ...open },
      1,
      refused("merge-unverified", `merge-async queued a job without a uuid${UNSETTLED}`),
      [squash, asyncPut],
    ],
    [
      "reports an unverified merge when the read-back fails after merge-async",
      { merge: [STACKED], outcome: [{ stderr: "HTTP 502\n", exit: 1 }] },
      1,
      refused(
        "merge-unverified",
        `merge-async job ${JOB} reported merged, then reading the PR back failed, so it may have merged. Rerun merge-gate without --merge.`
      ),
      [squash, asyncPut, asyncPoll],
    ],
  ])("merges a stacked PR: %s", async (_name, scenario, exit, verdict, expectedMerges) => {
    const gh = await setup(scenario);
    const result = runCli(gh, ["7", "--repo", "acme/app", "--merge"]);
    expect(result).toEqual({ exit, verdict });
    expect([...(await merges(gh)), ...(await asyncMerges(gh))]).toEqual([...expectedMerges]);
  });

  it.each<[string, string | null]>([
    ["the policy file is missing", null],
    ["the policy file is not JSON", "{"],
  ])("refuses without calling gh when %s", async (_name, policy) => {
    const gh = await setup({ policy });
    const result = runCli(gh, ["7", "--repo", "acme/app", "--merge"]);
    expect({ ...result, verdict: withCodes(result.verdict) }).toEqual({
      exit: 2,
      verdict: {
        repo: "acme/app",
        pr: 7,
        head: null,
        stack: null,
        decision: "refuse",
        merged: false,
        mergeCommit: null,
        reasons: ["policy-invalid"],
      },
    });
    expect(await gh.calls()).toEqual([]);
  });

  it("infers the repo from the checkout's origin remote", async () => {
    const gh = await setup();
    const checkout = join(gh.directory, "checkout");
    Bun.spawnSync(["git", "init", "-q", checkout]);
    Bun.spawnSync(["git", "-C", checkout, "remote", "add", "origin", "git@github.com:acme/app.git"]);
    const result = runCli(gh, ["7"], checkout);
    expect(result.exit).toBe(0);
    expect(result.verdict).toMatchObject({ repo: "acme/app", decision: "merge" });
  });

  it.each<[string, readonly string[]]>([
    ["a non-numeric PR", ["abc", "--repo", "acme/app"]],
    ["a malformed --repo", ["7", "--repo", "acme"]],
    ["a URL that contradicts --repo", ["https://github.com/acme/app/pull/7", "--repo", "acme/other"]],
    ["an unknown flag", ["7", "--repo", "acme/app", "--admin"]],
    ["a policy path override", ["7", "--repo", "acme/app", "--policy", "/tmp/permissive.json"]],
  ])("refuses %s as invalid arguments", async (_name, args) => {
    const gh = await setup();
    const result = runCli(gh, args);
    expect(result.exit).toBe(2);
    expect(withCodes(result.verdict)).toMatchObject({ decision: "refuse", reasons: ["invalid-arguments"] });
    expect(await gh.calls()).toEqual([]);
  });
});

const HEAD_5 = "5555555555555555555555555555555555555555";
const HEAD_6 = "6666666666666666666666666666666666666666";
const STACK_PRS: Readonly<Record<number, PrFixture>> = {
  [prAt(1)]: { head: HEAD_5, headRefName: "feature-5", baseRefName: "main", stack: 42 },
  [prAt(2)]: { head: HEAD_6, headRefName: "feature-6", baseRefName: "feature-5", stack: 42 },
  [prAt(3)]: { head: HEAD, headRefName: "feature-7", baseRefName: "feature-6", stack: 42 },
};

interface StackScenario {
  readonly stack?: FakeRule[1];
  readonly prs?: Readonly<Record<number, PrFixture>>;
  readonly asyncPolls?: FakeRule[1];
}

function stackRules(scenario: StackScenario): readonly FakeRule[] {
  return [
    ["api user", [{ stdout: { login: "agent" } }]],
    ["query MergeGateStack", scenario.stack ?? [stackPage(["OPEN", "OPEN", "OPEN"])]],
    ...[1, 2, 3].map(prAt).flatMap((number) => prRules(number, { ...STACK_PRS[number], ...scenario.prs?.[number] })),
    ["pr merge", [{ stderr: "merge-gate must not call gh pr merge on a stack\n", exit: 1 }]],
    [`pulls/7/merge-async/${JOB}`, scenario.asyncPolls ?? [{ stdout: { status: "merged", details: { uuid: JOB } } }]],
    ["pulls/7/merge-async", [{ stdout: { status: "pending", details: { uuid: JOB } } }]],
  ];
}

describe("merge-gate --stack against a fake gh", () => {
  const gatedPrs = async (gh: FakeGh) =>
    (await gh.calls()).flatMap((argv) => {
      const match = /^repos\/acme\/app\/pulls\/(\d+)\/files/.exec(argv[1] ?? "");
      return match === null ? [] : [Number(match[1])];
    });
  const subject = (prs: readonly number[] | null, head: string | null = HEAD) => ({
    repo: "acme/app",
    pr: 7,
    head,
    stack: prs === null ? null : { number: 42, prs },
  });
  const merged = (prs: readonly number[]): Verdict => ({
    ...subject(prs),
    decision: "merge",
    merged: true,
    mergeCommit: MERGE_COMMIT,
    reasons: [],
  });
  const mergeable = (prs: readonly number[]): Verdict => ({ ...merged(prs), merged: false, mergeCommit: null });
  const refused = (base: ReturnType<typeof subject>, code: ReasonCode, detail: string): Verdict => ({
    ...base,
    decision: "refuse",
    merged: false,
    mergeCommit: null,
    reasons: [{ code, detail }],
  });
  const ALL = [5, 6, 7];
  const UNSETTLED =
    "so the stack may still merge. Wait for gh pr view to show every PR settled before rerunning merge-gate --stack --merge.";
  const open = { outcome: [outcome("OPEN", null)] };
  it.each<{
    name: string;
    scenario: StackScenario;
    merge: boolean;
    exit: number;
    verdict: Verdict;
    gated: readonly number[];
    calls: readonly (readonly string[])[];
  }>([
    {
      name: "merges the whole range with one merge-async call pinned to the top head",
      scenario: {},
      merge: true,
      exit: 0,
      verdict: merged(ALL),
      gated: ALL,
      calls: [asyncPut, asyncPoll],
    },
    { name: "reports the range as mergeable without merging", scenario: {}, merge: false, exit: 0, verdict: mergeable(ALL), gated: ALL, calls: [] },
    {
      name: "reads stack entries across pages",
      scenario: { stack: [stackPage(["OPEN", "OPEN"], { cursor: "Mg" }), stackPage(["OPEN"], { from: 3 })] },
      merge: false,
      exit: 0,
      verdict: mergeable(ALL),
      gated: ALL,
      calls: [],
    },
    {
      name: "refuses a stack whose positions skip one",
      scenario: { stack: [stackPage(["OPEN"], { cursor: "MQ" }), stackPage(["OPEN"], { from: 3 })] },
      merge: true,
      exit: 2,
      verdict: refused(subject(null, null), "github-error", "stack #42 lists positions 1, 3"),
      gated: [],
      calls: [],
    },
    {
      name: "refuses a middle PR with pending checks and names it",
      scenario: { prs: { 6: { checks: "pending" } } },
      merge: true,
      exit: 2,
      verdict: refused(subject(ALL), "checks-pending", "#6: pending: e2e"),
      gated: ALL,
      calls: [],
    },
    {
      name: "refuses a PR whose base is not the head of the PR below it",
      scenario: { prs: { 7: { baseRefName: "feature-5" } } },
      merge: true,
      exit: 2,
      verdict: refused(subject(ALL), "base-not-trunk", "#7: base is feature-5, the head of #6 below it is feature-6"),
      gated: ALL,
      calls: [],
    },
    {
      name: "refuses a stack that targets a branch other than the default",
      scenario: { prs: { 5: { baseRefName: "release" } } },
      merge: true,
      exit: 2,
      verdict: refused(subject(ALL), "base-not-trunk", "#5: base is release, the default branch is main"),
      gated: ALL,
      calls: [],
    },
    {
      name: "skips a merged lower entry and gates the rest against trunk",
      scenario: { stack: [stackPage(["MERGED", "OPEN", "OPEN"])], prs: { 6: { baseRefName: "main" } } },
      merge: true,
      exit: 0,
      verdict: merged([6, 7]),
      gated: [6, 7],
      calls: [asyncPut, asyncPoll],
    },
    {
      name: "refuses a closed lower entry",
      scenario: { stack: [stackPage(["CLOSED", "OPEN", "OPEN"])] },
      merge: true,
      exit: 2,
      verdict: refused(subject([6, 7], null), "not-open", "#5: PR is closed"),
      gated: [],
      calls: [],
    },
    {
      name: "refuses a PR that is not in a native stack",
      scenario: { stack: [NOT_STACKED] },
      merge: true,
      exit: 2,
      verdict: refused(subject(null, null), "invalid-arguments", "#7 is not in a native stack; rerun without --stack"),
      gated: [],
      calls: [],
    },
    {
      name: "refuses when a lower head moves before merging",
      scenario: { prs: { 5: { viewHeads: [HEAD_5, MOVED] } } },
      merge: true,
      exit: 2,
      verdict: refused(subject(ALL), "head-moved", `#5: head was ${HEAD_5}, then ${MOVED} before merging`),
      gated: ALL,
      calls: [],
    },
    {
      name: "reports an unverified merge when one PR in the range does not read merged",
      scenario: { prs: { 6: open } },
      merge: true,
      exit: 1,
      verdict: refused(subject(ALL), "merge-unverified", `merge-async job ${JOB} reported merged; #6 is OPEN, ${UNSETTLED}`),
      gated: ALL,
      calls: [asyncPut, asyncPoll],
    },
    {
      name: "refuses a failed merge when no PR in the range merged",
      scenario: {
        asyncPolls: [{ stdout: { status: "failed", details: { message: "Merge conflict" } } }],
        prs: { 5: open, 6: open, 7: open },
      },
      merge: true,
      exit: 2,
      verdict: refused(subject(ALL), "merge-failed", `merge-async job ${JOB} failed: Merge conflict; #5 is OPEN, #6 is OPEN, #7 is OPEN`),
      gated: ALL,
      calls: [asyncPut, asyncPoll],
    },
  ])("$name", async ({ scenario, merge, exit, verdict, gated, calls }) => {
    const gh = await setup({}, stackRules(scenario));
    const result = runCli(gh, ["7", "--repo", "acme/app", "--stack", ...(merge ? ["--merge"] : [])]);
    expect(result).toEqual({ exit, verdict });
    expect((await gatedPrs(gh)).sort()).toEqual([...gated]);
    expect([...(await merges(gh)), ...(await asyncMerges(gh))]).toEqual([...calls]);
  });

  it("points a plain run at --stack when the PR is in a native stack", async () => {
    const gh = await setup({ baseRefName: "feature-6", stack: 42 });
    const result = runCli(gh, ["7", "--repo", "acme/app", "--merge"]);
    expect(result).toEqual({
      exit: 2,
      verdict: refused(
        subject(null),
        "base-not-trunk",
        "base is feature-6, the default branch is main; PR is in native stack #42, so rerun with --stack to gate it with the PRs below it"
      ),
    });
    expect(await gh.calls()).not.toContainEqual(expect.arrayContaining([expect.stringContaining("query MergeGateStack")]));
    expect(await merges(gh)).toEqual([]);
  });
});

describe("main", () => {
  it("exits 1 and refuses on an unexpected error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "merge-gate-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const policy = join(directory, "policy.json");
    await Bun.write(policy, JSON.stringify(POLICY));
    const stdout: string[] = [];
    const unexpected = async (): Promise<never> => {
      throw new TypeError("boom");
    };
    const code = await main(["7", "--repo", "acme/app", "--merge"], {
      policyPath: policy,
      github: {
        originRepo: unexpected,
        viewer: unexpected,
        facts: unexpected,
        head: unexpected,
        merge: unexpected,
        stack: unexpected,
        mergeStack: unexpected,
      },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(stdout.join(""))).toEqual({
      repo: "acme/app",
      pr: 7,
      head: null,
      stack: null,
      decision: "refuse",
      merged: false,
      mergeCommit: null,
      reasons: [{ code: "internal-error", detail: "TypeError: boom" }],
    });
  });
});
