import { describe, expect, it } from "bun:test";
import { PolicyError, parsePolicy, repoPolicy } from "./policy.ts";

const valid = {
  defaults: { humanOnly: [".github/**"] },
  repos: {
    "acme/app": {
      humanOnly: ["billing/**"],
      requireHumanApprovalOnHead: true,
      mergeCommitBranches: ["sync/*"],
    },
    "acme/*": {},
  },
};

describe("parsePolicy", () => {
  it("resolves an exact key with defaults prepended", () => {
    expect(
      repoPolicy(parsePolicy(valid), { owner: "Acme", repo: "App" })
    ).toEqual({
      humanOnly: [".github/**", "billing/**"],
      requireHumanApprovalOnHead: true,
      mergeCommitBranches: ["sync/*"],
    });
  });

  it("falls back to the owner wildcard, then to nothing", () => {
    const policy = parsePolicy(valid);
    expect(repoPolicy(policy, { owner: "acme", repo: "site" })).toEqual({
      humanOnly: [".github/**"],
      requireHumanApprovalOnHead: false,
      mergeCommitBranches: [],
    });
    expect(repoPolicy(policy, { owner: "other", repo: "app" })).toBeNull();
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
    ["a non-object repo entry", { ...valid, repos: { "acme/app": true } }],
    ["a repo key without an owner", { ...valid, repos: { app: {} } }],
    ["a wildcard owner", { ...valid, repos: { "*/*": {} } }],
    ["a nested repo key", { ...valid, repos: { "acme/app/x": {} } }],
    ["keys that differ only by case", { ...valid, repos: { "acme/app": {}, "Acme/App": {} } }],
  ])("rejects %s", (_name, value) => {
    expect(() => parsePolicy(value)).toThrow(PolicyError);
  });
});
