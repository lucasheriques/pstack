import { describe, expect, it } from "bun:test";
import type * as W from "../watch-pr/types.ts";
import {
  type ClassifiedVerdict,
  type Commit,
  type Merge,
  type Run,
  type Snapshot,
  type Workflow,
  type WorkflowState,
  classify,
  isRevert,
  overall,
  reverts,
} from "./watch.ts";

const REPO: W.Repository = { owner: "acme", repo: "app" };
const MERGE: Merge = { sha: "m1", message: "Merge pull request #42 from acme/app (#42)", committedAt: "2026-01-01T00:00:00Z" };
const CI: Workflow = { id: 1, name: "CI", path: ".github/workflows/ci.yml" };
const DEPLOY: Workflow = { id: 2, name: "Deploy", path: ".github/workflows/deploy.yml" };

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    workflow: CI,
    sha: MERGE.sha,
    status: "completed",
    conclusion: "success",
    createdAt: "2026-01-01T00:01:00Z",
    url: "https://github.com/acme/app/actions/runs/1",
    ...overrides,
  };
}

function commit(sha: string, message = "chore: unrelated"): Commit {
  return { sha, message };
}

describe("isRevert", () => {
  it.each<[string, string, boolean]>([
    ["a revert subject", 'Revert "fix: bug"\n\nThis reverts commit abc.', true],
    ["a reverts-commit trailer without the revert subject", "fix: bug\n\nThis reverts commit abc123.", true],
    ["a Reverts owner/repo#N trailer", "fix: bug\n\nReverts acme/app#42\n", true],
    ["an unrelated commit", "fix: unrelated bug\n\nNo trailers here.", false],
  ])("%s -> %s", (_name, message, expected) => {
    expect(isRevert(message)).toBe(expected);
  });
});

describe("reverts", () => {
  it.each<[string, string, boolean]>([
    ["a This reverts commit <merge sha> trailer", `Revert something\n\nThis reverts commit ${MERGE.sha}.`, true],
    ['a Revert "<merge subject>" subject', `Revert "${MERGE.message.split("\n")[0]}"\n\nThis reverts commit deadbeef.`, true],
    ["a Reverts owner/repo#N trailer matching the merge's PR number", "Revert something\n\nReverts acme/app#42\n", true],
    ["an unrelated commit", "fix: something else entirely", false],
    ["a revert of a different commit", "Revert something\n\nThis reverts commit ffffffff.", false],
  ])("%s -> %s", (_name, message, expected) => {
    expect(reverts(message, MERGE, REPO)).toBe(expected);
  });
});

describe("classify", () => {
  const base = (mergeRun: Run, extra: readonly Run[] = [], after: readonly Commit[] | null = []): Snapshot => ({
    runs: [mergeRun, ...extra],
    after,
  });
  const expect1 = (verdict: Partial<ClassifiedVerdict>): ClassifiedVerdict => ({
    workflowId: CI.id,
    workflow: CI.name,
    path: CI.path,
    state: "pending",
    run: null,
    sha: null,
    ...verdict,
  });

  it.each<[string, Snapshot, readonly Workflow[], readonly ClassifiedVerdict[]]>([
    [
      "green merge run",
      base(run({ status: "completed", conclusion: "success" })),
      [],
      [expect1({ state: "green", run: run().url, sha: MERGE.sha })],
    ],
    [
      "red merge run",
      base(run({ status: "completed", conclusion: "failure" })),
      [],
      [expect1({ state: "red-own", run: run().url, sha: MERGE.sha })],
    ],
    [
      "in-progress merge run",
      base(run({ status: "in_progress", conclusion: null })),
      [],
      [expect1({ state: "pending", run: run().url, sha: MERGE.sha })],
    ],
    [
      "waiting merge run",
      base(run({ status: "waiting", conclusion: null })),
      [],
      [expect1({ state: "waiting-approval", run: run().url, sha: MERGE.sha })],
    ],
    [
      "cancelled merge run with a later green run",
      base(
        run({ id: 1, status: "completed", conclusion: "cancelled" }),
        [run({ id: 2, sha: "c1", conclusion: "success", createdAt: "2026-01-01T00:05:00Z", url: "https://github.com/acme/app/actions/runs/2" })],
        [commit("c1")]
      ),
      [],
      [expect1({ state: "green-inherited", run: "https://github.com/acme/app/actions/runs/2", sha: "c1" })],
    ],
    [
      "skipped merge run with a later red run",
      base(
        run({ id: 1, status: "completed", conclusion: "skipped" }),
        [run({ id: 2, sha: "c1", conclusion: "failure", createdAt: "2026-01-01T00:05:00Z", url: "https://github.com/acme/app/actions/runs/2" })],
        [commit("c1")]
      ),
      [],
      [expect1({ state: "red-inherited", run: "https://github.com/acme/app/actions/runs/2", sha: "c1" })],
    ],
    [
      "cancelled merge run, then a cancelled run, then a green run",
      base(
        run({ id: 1, status: "completed", conclusion: "cancelled" }),
        [
          run({ id: 2, sha: "c1", conclusion: "cancelled", createdAt: "2026-01-01T00:05:00Z", url: "https://github.com/acme/app/actions/runs/2" }),
          run({ id: 3, sha: "c2", conclusion: "success", createdAt: "2026-01-01T00:06:00Z", url: "https://github.com/acme/app/actions/runs/3" }),
        ],
        [commit("c1"), commit("c2")]
      ),
      [],
      [expect1({ state: "green-inherited", run: "https://github.com/acme/app/actions/runs/3", sha: "c2" })],
    ],
    [
      "cancelled merge run whose only later run is on a commit after a revert of the merge",
      base(
        run({ id: 1, status: "completed", conclusion: "cancelled" }),
        [run({ id: 2, sha: "c2", conclusion: "success", createdAt: "2026-01-01T00:06:00Z" })],
        [commit("c1", `Revert something\n\nThis reverts commit ${MERGE.sha}.`), commit("c2")]
      ),
      [],
      [expect1({ state: "pending", run: run().url, sha: MERGE.sha })],
    ],
    [
      "cancelled merge run whose earliest later run is still running while a newer one is green",
      base(
        run({ id: 1, status: "completed", conclusion: "cancelled" }),
        [
          run({ id: 2, sha: "c1", status: "in_progress", conclusion: null, createdAt: "2026-01-01T00:05:00Z", url: "https://github.com/acme/app/actions/runs/2" }),
          run({ id: 3, sha: "c2", conclusion: "success", createdAt: "2026-01-01T00:06:00Z", url: "https://github.com/acme/app/actions/runs/3" }),
        ],
        [commit("c1"), commit("c2")]
      ),
      [],
      [expect1({ state: "pending", run: "https://github.com/acme/app/actions/runs/2", sha: "c1" })],
    ],
    [
      "expected workflow with no run at all",
      base(run({ workflow: DEPLOY, status: "completed", conclusion: "success" }), [], []),
      [CI],
      [
        { workflowId: DEPLOY.id, workflow: DEPLOY.name, path: DEPLOY.path, state: "green", run: run().url, sha: MERGE.sha },
        expect1({ state: "pending", run: null, sha: null }),
      ],
    ],
    [
      "workflow that ran only on a later commit",
      { runs: [run(), run({ id: 2, workflow: DEPLOY, sha: "c1", createdAt: "2026-01-01T00:05:00Z" })], after: [commit("c1")] },
      [],
      [expect1({ state: "green", run: run().url, sha: MERGE.sha })],
    ],
    [
      "no commits after the merge (after is null)",
      base(run({ status: "completed", conclusion: "cancelled" }), [], null),
      [],
      [expect1({ state: "pending", run: run().url, sha: MERGE.sha })],
    ],
  ])("%s", (_name, snapshot, expected, expectedVerdicts) => {
    expect(classify(MERGE, REPO, snapshot, expected)).toEqual(expectedVerdicts);
  });
});

describe("overall", () => {
  it.each<[string, readonly WorkflowState[], WorkflowState]>([
    ["no workflows", [], "green"],
    ["all green", ["green", "green"], "green"],
    ["a green-inherited among greens", ["green", "green-inherited"], "green-inherited"],
    ["a pending among greens", ["green", "pending"], "pending"],
    ["a waiting-approval outranks pending", ["pending", "waiting-approval"], "waiting-approval"],
    ["an unknown outranks waiting-approval", ["waiting-approval", "unknown"], "unknown"],
    ["a red-inherited outranks unknown", ["unknown", "red-inherited"], "red-inherited"],
    ["a red-own outranks everything", ["red-inherited", "red-own", "green"], "red-own"],
  ])("%s -> %s", (_name, states, expected) => {
    expect(overall(states)).toBe(expected);
  });
});
