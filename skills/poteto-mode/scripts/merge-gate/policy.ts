import { readFile } from "node:fs/promises";
import type { Repository } from "../watch-pr/types.ts";

export interface RepoPolicy {
  readonly humanOnly: readonly string[];
  readonly requireHumanApprovalOnHead: boolean;
  readonly mergeCommitBranches: readonly string[];
}

/** Repo entries keyed by lowercased "owner/name" or "owner/*", with defaults.humanOnly already prepended. */
export interface Policy {
  readonly repos: ReadonlyMap<string, RepoPolicy>;
}

export class PolicyError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "PolicyError";
  }
}

const REPO_KEY = /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// An unknown key is refused rather than ignored: a misspelled
// requireHumanApprovalOnHead would otherwise silently loosen the policy.
function object(
  value: unknown,
  path: string,
  keys: readonly string[] | "any"
): Record<string, unknown> {
  if (!isRecord(value)) throw new PolicyError(`${path} must be an object`);
  if (keys !== "any")
    for (const key of Object.keys(value))
      if (!keys.includes(key))
        throw new PolicyError(`${path} has unknown key "${key}"`);
  return value;
}

function globs(value: unknown, path: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((glob) => typeof glob === "string" && glob !== "")
  )
    throw new PolicyError(`${path} must be an array of non-empty glob strings`);
  return value;
}

function repoEntry(
  value: unknown,
  path: string,
  defaults: readonly string[]
): RepoPolicy {
  const entry = object(value, path, [
    "humanOnly",
    "requireHumanApprovalOnHead",
    "mergeCommitBranches",
  ]);
  const requireHuman = entry.requireHumanApprovalOnHead ?? false;
  if (typeof requireHuman !== "boolean")
    throw new PolicyError(`${path}.requireHumanApprovalOnHead must be a boolean`);
  return {
    humanOnly: [
      ...defaults,
      ...globs(entry.humanOnly ?? [], `${path}.humanOnly`),
    ],
    requireHumanApprovalOnHead: requireHuman,
    mergeCommitBranches: globs(
      entry.mergeCommitBranches ?? [],
      `${path}.mergeCommitBranches`
    ),
  };
}

export function parsePolicy(value: unknown): Policy {
  const root = object(value, "policy", ["defaults", "repos"]);
  const defaults = globs(
    object(root.defaults, "defaults", ["humanOnly"]).humanOnly,
    "defaults.humanOnly"
  );
  const repos = new Map<string, RepoPolicy>();
  for (const [key, entry] of Object.entries(object(root.repos, "repos", "any"))) {
    if (!REPO_KEY.test(key))
      throw new PolicyError(`repos key "${key}" must be "owner/name" or "owner/*"`);
    const normalized = key.toLowerCase();
    if (repos.has(normalized))
      throw new PolicyError(`repos key "${key}" duplicates another key ignoring case`);
    repos.set(normalized, repoEntry(entry, `repos["${key}"]`, defaults));
  }
  return { repos };
}

export async function loadPolicy(path: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new PolicyError(`cannot read ${path}: ${String(error)}`);
  }
  try {
    return parsePolicy(JSON.parse(text));
  } catch (error) {
    if (error instanceof PolicyError) throw new PolicyError(`${path}: ${error.message}`);
    throw new PolicyError(`${path} is not valid JSON: ${String(error)}`);
  }
}

/** GitHub names are case-insensitive, so lookup is too. An exact key wins over "owner/*". */
export function repoPolicy(policy: Policy, repo: Repository): RepoPolicy | null {
  const owner = repo.owner.toLowerCase();
  return (
    policy.repos.get(`${owner}/${repo.repo.toLowerCase()}`) ??
    policy.repos.get(`${owner}/*`) ??
    null
  );
}
