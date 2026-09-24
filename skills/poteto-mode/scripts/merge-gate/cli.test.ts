import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Verdict, main } from "./cli.ts";
import { type FakeGh, type FakeResponse, type FakeRule, fakeGh } from "./fake-gh.test-helper.ts";

const LAUNCHER = join(import.meta.dir, "merge-gate");
const HEAD = "1111111111111111111111111111111111111111";
const MOVED = "2222222222222222222222222222222222222222";
const MERGE_COMMIT = "3333333333333333333333333333333333333333";
const POLICY = {
  defaults: { humanOnly: [".github/**"] },
  repos: { "acme/app": { mergeCommitBranches: ["sync/*"] } },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Scenario {
  readonly headRefName?: string;
  readonly isDraft?: boolean;
  readonly viewHeads?: readonly string[];
  readonly checks?: "passing" | "none";
  readonly user?: FakeRule[1];
  readonly merge?: FakeRule[1];
  readonly outcome?: FakeRule[1];
  readonly defaultBranch?: string | null;
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

function rules(scenario: Scenario = {}): readonly FakeRule[] {
  const view = (head: string) => ({
    stdout: {
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "",
      headRefOid: head,
      headRefName: scenario.headRefName ?? "feature",
      baseRefName: "main",
      state: "OPEN",
      mergedAt: null,
      isDraft: scenario.isDraft ?? false,
    },
  });
  const pullRequest = (value: unknown) => ({
    stdout: { data: { repository: { pullRequest: value } } },
  });
  return [
    ["api user", scenario.user ?? [{ stdout: { login: "agent" } }]],
    [
      "query MergeGatePr",
      [
        {
          stdout: {
            data: {
              repository: {
                nameWithOwner: "acme/app",
                defaultBranchRef:
                  scenario.defaultBranch === null ? null : { name: scenario.defaultBranch ?? "main" },
                pullRequest: {
                  headRefOid: HEAD,
                  baseRefName: "main",
                  changedFiles: 1,
                  author: { __typename: "User", login: "agent" },
                  reviewThreads: { totalCount: 0 },
                  reviews: { nodes: [] },
                },
              },
            },
          },
        },
      ],
    ],
    ["repos/acme/app/pulls/7/files", [{ stdout: [{ filename: "src/index.ts" }] }]],
    ["pr view 7 --repo acme/app", (scenario.viewHeads ?? [HEAD]).map(view)],
    [
      "pr checks 7",
      scenario.checks === "none"
        ? [{ stderr: "no checks reported on the 'feature' branch\n", exit: 1 }]
        : [
            {
              stdout: [
                {
                  name: "test",
                  state: "SUCCESS",
                  description: "",
                  link: "",
                  workflow: "ci",
                  bucket: "pass",
                },
              ],
            },
          ],
    ],
    [
      "query PrCheckRollup",
      [pullRequest({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })],
    ],
    ["query ReviewThreads", [pullRequest({ reviewThreads: { nodes: [] } })]],
    [
      "query PrCommitStatuses",
      [
        pullRequest({
          commits: {
            nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: "SUCCESS" } } }],
          },
        }),
      ],
    ],
    ["pr merge 7", scenario.merge ?? [{ stdout: "" }]],
    ["query MergeGateOutcome", scenario.outcome ?? [outcome("MERGED", MERGE_COMMIT)]],
  ];
}

async function setup(scenario: Scenario = {}): Promise<FakeGh> {
  const gh = await fakeGh(rules(scenario));
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

const squash = ["pr", "merge", "7", "--repo", "acme/app", "--match-head-commit", HEAD, "--squash"];

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

  const subject = { repo: "acme/app", pr: 7, head: HEAD };
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
  ])("reads the PR back after merging: %s", async (_name, scenario, exit, verdict) => {
    const gh = await setup(scenario);
    const result = runCli(gh, ["7", "--repo", "acme/app", "--merge"]);
    expect(result).toEqual({ exit, verdict });
    expect(await merges(gh)).toEqual([squash]);
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
      },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(stdout.join(""))).toEqual({
      repo: "acme/app",
      pr: 7,
      head: null,
      decision: "refuse",
      merged: false,
      mergeCommit: null,
      reasons: [{ code: "internal-error", detail: "TypeError: boom" }],
    });
  });
});
