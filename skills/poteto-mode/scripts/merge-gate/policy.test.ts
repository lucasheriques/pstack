import { describe, expect, it } from "bun:test";
import { PolicyError, type RepoPolicy, parsePolicy, repoPolicy } from "./policy.ts";

const valid = {
  defaults: { humanOnly: [".github/**"] },
  repos: {
    "acme/app": {
      humanOnly: ["billing/**", ".github/**"],
      mergeCommitBranches: ["sync/*"],
    },
    "acme/*": {
      humanOnly: ["infra/**"],
      requireHumanApprovalOnHead: true,
      mergeCommitBranches: ["release/*"],
    },
    "solo/app": { requireHumanApprovalOnHead: true },
    "loose/*": {},
  },
};

describe("parsePolicy", () => {
  it.each<[string, RepoPolicy | null]>([
    [
      "Acme/App",
      {
        humanOnly: [".github/**", "infra/**", "billing/**"],
        requireHumanApprovalOnHead: true,
        mergeCommitBranches: ["release/*", "sync/*"],
      },
    ],
    [
      "acme/site",
      {
        humanOnly: [".github/**", "infra/**"],
        requireHumanApprovalOnHead: true,
        mergeCommitBranches: ["release/*"],
      },
    ],
    [
      "solo/app",
      { humanOnly: [".github/**"], requireHumanApprovalOnHead: true, mergeCommitBranches: [] },
    ],
    [
      "loose/app",
      { humanOnly: [".github/**"], requireHumanApprovalOnHead: false, mergeCommitBranches: [] },
    ],
    ["solo/other", null],
    ["other/app", null],
  ])("resolves %s from defaults, the owner wildcard and the exact key", (slug, expected) => {
    const [owner, repo] = slug.split("/");
    expect(repoPolicy(parsePolicy(valid), { owner, repo })).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["a non-object", []],
    ["missing defaults", { repos: {} }],
    ["missing repos", { defaults: { humanOnly: [] } }],
    ["missing defaults.humanOnly", { defaults: {}, repos: {} }],
    ["a non-array glob list", { defaults: { humanOnly: "**" }, repos: {} }],
    ["an empty glob", { defaults: { humanOnly: [""] }, repos: {} }],
    ["a non-string glob", { defaults: { humanOnly: [1] }, repos: {} }],
    ["an unknown top-level key", { ...valid, extra: true }],
    ["an unknown defaults key", { ...valid, defaults: { humanOnly: [], mergeCommitBranches: [] } }],
    ["a misspelled repo key", { ...valid, repos: { "acme/app": { requireHumanAprovalOnHead: true } } }],
    ["a non-boolean approval flag", { ...valid, repos: { "acme/app": { requireHumanApprovalOnHead: "yes" } } }],
    ["a null approval flag", { ...valid, repos: { "acme/app": { requireHumanApprovalOnHead: null } } }],
    ["a null glob list", { ...valid, repos: { "acme/app": { humanOnly: null } } }],
    ["a non-object repo entry", { ...valid, repos: { "acme/app": true } }],
    ["a repo key without an owner", { ...valid, repos: { app: {} } }],
    ["a wildcard owner", { ...valid, repos: { "*/*": {} } }],
    ["a nested repo key", { ...valid, repos: { "acme/app/x": {} } }],
    ["keys that differ only by case", { ...valid, repos: { "acme/app": {}, "Acme/App": {} } }],
  ])("rejects %s", (_name, value) => {
    expect(() => parsePolicy(value)).toThrow(PolicyError);
  });
});
