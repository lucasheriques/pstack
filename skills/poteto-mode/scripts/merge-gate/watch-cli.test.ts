import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type * as W from "../watch-pr/types.ts";
import { type WatchRuntime, runWatch } from "./cli.ts";
import { fakeGh } from "./fake-gh.test-helper.ts";
import { GitHubError } from "./github.ts";
import type { Commit, Merge, Run, WatchGitHub, WatchVerdict, Workflow } from "./watch.ts";

const REPO: W.Repository = { owner: "acme", repo: "app" };
const MERGE: Merge = { sha: "m1", message: "Fix login timeout (#42)", committedAt: "2026-01-01T00:00:00Z" };
const CI: Workflow = { id: 1, name: "CI", path: ".github/workflows/ci.yml" };
const RUN_GREEN: Run = {
  id: 1,
  workflow: CI,
  sha: MERGE.sha,
  status: "completed",
  conclusion: "success",
  createdAt: "2026-01-01T00:01:00Z",
  url: "https://github.com/acme/app/actions/runs/1",
};
const RUN_PENDING: Run = { ...RUN_GREEN, status: "in_progress", conclusion: null };

const REQUEST = {
  sha: MERGE.sha,
  repo: REPO,
  paths: [] as readonly string[],
  timeoutMinutes: 60,
  intervalSeconds: 10,
  settleSeconds: 30,
};

type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };
const value = <T,>(v: T): Step<T> => ({ ok: true, value: v });
const failure = (error: Error): Step<never> => ({ ok: false, error });

function stepper<T>(steps: readonly Step<T>[]): () => Promise<T> {
  let call = 0;
  return async () => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    if (step.ok) return step.value;
    throw step.error;
  };
}

function fakeGithub(overrides: {
  readonly originRepo?: () => Promise<W.Repository | null>;
  readonly runs?: () => Promise<readonly Run[]>;
  readonly commitsAfter?: () => Promise<readonly Commit[] | null>;
  readonly previousConclusion?: () => Promise<string | null>;
} = {}): WatchGitHub {
  return {
    originRepo: overrides.originRepo ?? (async () => REPO),
    defaultBranch: async () => "main",
    commit: async () => MERGE,
    workflows: async () => [],
    runs: overrides.runs ?? (async () => []),
    commitsAfter: overrides.commitsAfter ?? (async () => []),
    previousConclusion: overrides.previousConclusion ?? (async () => null),
  };
}

function fakeClock(): WatchRuntime & { readonly sleeps: readonly number[] } {
  let time = 0;
  const sleeps: number[] = [];
  const github = fakeGithub();
  return {
    github,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}

describe("runWatch (the polling loop, against a fake WatchGitHub and a fake clock)", () => {
  it("settles green once the verdict has held for the settle window", async () => {
    const clock = fakeClock();
    const verdict = await runWatch(REQUEST, { ...clock, github: fakeGithub({ runs: async () => [RUN_GREEN] }) });
    expect(verdict.state).toBe("green");
    expect(clock.sleeps).toEqual([10_000, 10_000, 10_000]);
  });

  it("converts a still-pending verdict to unknown once the timeout elapses", async () => {
    const clock = fakeClock();
    const verdict = await runWatch(
      { ...REQUEST, timeoutMinutes: 1, intervalSeconds: 15 },
      { ...clock, github: fakeGithub({ runs: async () => [RUN_PENDING] }) }
    );
    expect(verdict.state).toBe("unknown");
    expect(verdict.workflows).toEqual([
      { workflow: "CI", path: CI.path, state: "unknown", run: RUN_PENDING.url, sha: MERGE.sha, previousRed: null },
    ]);
  });

  it("keeps polling through a GitHubError and recovers once a poll succeeds", async () => {
    const clock = fakeClock();
    const runs = stepper<readonly Run[]>([failure(new GitHubError("boom")), value([RUN_GREEN])]);
    const verdict = await runWatch({ ...REQUEST, settleSeconds: 20 }, { ...clock, github: fakeGithub({ runs }) });
    expect(verdict.error).toBeNull();
    expect(verdict.state).toBe("green");
  });

  it("takes exactly one snapshot with --timeout 0 and reports pending as pending", async () => {
    const clock = fakeClock();
    const verdict = await runWatch(
      { ...REQUEST, timeoutMinutes: 0 },
      { ...clock, github: fakeGithub({ runs: async () => [RUN_PENDING] }) }
    );
    expect(verdict.state).toBe("pending");
    expect(clock.sleeps).toEqual([]);
  });

  it.each<[string, Partial<typeof REQUEST>, Parameters<typeof fakeGithub>[0], Pick<WatchVerdict, "state" | "error">]>([
    [
      "every poll fails until the timeout",
      { timeoutMinutes: 1 },
      { runs: async () => { throw new GitHubError("HTTP 502"); } },
      { state: "unknown", error: "HTTP 502" },
    ],
    [
      "the only snapshot fails",
      { timeoutMinutes: 0 },
      { runs: async () => { throw new GitHubError("HTTP 502"); } },
      { state: "unknown", error: "HTTP 502" },
    ],
    [
      "the previous-run lookup fails",
      {},
      { runs: async () => [RUN_GREEN], previousConclusion: async () => { throw new GitHubError("HTTP 404"); } },
      { state: "green", error: null },
    ],
  ])("never calls a merge green on a failed read: %s", async (_name, request, github, expected) => {
    const verdict = await runWatch({ ...REQUEST, ...request }, { ...fakeClock(), github: fakeGithub(github) });
    expect({ state: verdict.state, error: verdict.error }).toEqual(expected);
  });

  it("ends immediately with state unknown when the repository cannot be resolved", async () => {
    const clock = fakeClock();
    const verdict = await runWatch(
      { ...REQUEST, repo: null },
      { ...clock, github: fakeGithub({ originRepo: async () => null }) }
    );
    expect(verdict).toEqual({
      repo: null,
      sha: null,
      state: "unknown",
      isRevert: null,
      workflows: [],
      error: "cannot infer the repository from the origin remote; pass --repo owner/name",
    });
  });
});

const LAUNCHER = join(import.meta.dir, "merge-gate");
const MERGE_SHA = "1111111111111111111111111111111111111111";
const MESSAGE = "Fix login timeout (#42)";

function runCli(gh: { readonly bin: string; readonly directory: string }, args: readonly string[]) {
  const result = Bun.spawnSync([process.execPath, LAUNCHER, "watch", ...args], {
    env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH ?? ""}`, HOME: gh.directory },
  });
  return { exit: result.exitCode, verdict: JSON.parse(result.stdout.toString()) as WatchVerdict };
}

describe("merge-gate watch CLI against a fake gh", () => {
  it("reports a green merge with previousRed and isRevert filled", async () => {
    const gh = await fakeGh([
      ["actions/workflows/1/runs?branch=main&status=completed", [{ stdout: { workflow_runs: [{ conclusion: "failure" }] } }]],
      [
        "actions/runs?branch=main",
        [
          {
            stdout: {
              workflow_runs: [
                {
                  id: 1,
                  workflow_id: 1,
                  name: "CI",
                  path: ".github/workflows/ci.yml",
                  head_sha: MERGE_SHA,
                  head_branch: "main",
                  status: "completed",
                  conclusion: "success",
                  created_at: "2026-01-01T00:01:00Z",
                  html_url: "https://github.com/acme/app/actions/runs/1",
                },
              ],
            },
          },
        ],
      ],
      ["compare/", [{ stdout: { status: "identical", commits: [] } }]],
      [
        `repos/acme/app/commits/${MERGE_SHA}`,
        [
          {
            stdout: {
              sha: MERGE_SHA,
              commit: { message: MESSAGE, committer: { date: "2026-01-01T00:00:00Z" } },
            },
          },
        ],
      ],
      ["repos/acme/app", [{ stdout: { default_branch: "main" } }]],
    ]);
    try {
      const result = runCli(gh, [MERGE_SHA, "--repo", "acme/app", "--interval", "0", "--settle", "0"]);
      expect(result.exit).toBe(0);
      expect(result.verdict).toEqual({
        repo: "acme/app",
        sha: MERGE_SHA,
        state: "green",
        isRevert: false,
        workflows: [
          {
            workflow: "CI",
            path: ".github/workflows/ci.yml",
            state: "green",
            run: "https://github.com/acme/app/actions/runs/1",
            sha: MERGE_SHA,
            previousRed: true,
          },
        ],
        error: null,
      });
    } finally {
      await gh.cleanup();
    }
  });

  it("stays pending in snapshot mode when an expected deploy workflow never runs", async () => {
    const gh = await fakeGh([
      ["actions/workflows/2/runs?branch=main&status=completed", [{ stdout: { workflow_runs: [] } }]],
      ["actions/workflows?per_page=100", [{ stdout: { workflows: [{ id: 2, name: "Deploy", path: ".github/workflows/deploy.yml" }] } }]],
      ["actions/runs?branch=main", [{ stdout: { workflow_runs: [] } }]],
      ["compare/", [{ stdout: { status: "identical", commits: [] } }]],
      [
        `repos/acme/app/commits/${MERGE_SHA}`,
        [{ stdout: { sha: MERGE_SHA, commit: { message: MESSAGE, committer: { date: "2026-01-01T00:00:00Z" } } } }],
      ],
      ["repos/acme/app", [{ stdout: { default_branch: "main" } }]],
    ]);
    try {
      const result = runCli(gh, [
        MERGE_SHA,
        "--repo",
        "acme/app",
        "--paths",
        ".github/workflows/deploy.yml",
        "--timeout",
        "0",
        "--interval",
        "0",
        "--settle",
        "0",
      ]);
      expect(result.exit).toBe(2);
      expect(result.verdict).toEqual({
        repo: "acme/app",
        sha: MERGE_SHA,
        state: "pending",
        isRevert: false,
        workflows: [
          { workflow: "Deploy", path: ".github/workflows/deploy.yml", state: "pending", run: null, sha: null, previousRed: null },
        ],
        error: null,
      });
    } finally {
      await gh.cleanup();
    }
  });

  it("refuses an invalid sha as invalid arguments without calling gh", async () => {
    const gh = await fakeGh([]);
    try {
      const result = runCli(gh, ["not-a-sha", "--repo", "acme/app"]);
      expect(result.exit).toBe(2);
      expect(result.verdict).toMatchObject({ repo: null, sha: null, state: "unknown", isRevert: null, workflows: [] });
      expect(result.verdict.error).not.toBeNull();
      expect(await gh.calls()).toEqual([]);
    } finally {
      await gh.cleanup();
    }
  });
});
