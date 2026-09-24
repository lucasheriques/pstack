import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeResponse {
  readonly stdout?: unknown;
  readonly stderr?: string;
  readonly exit?: number;
}

/**
 * Each rule answers the gh invocations whose joined argv contains `match`.
 * Responses are served in order and the last one repeats, which is how a
 * scenario makes the head move between the read and the merge.
 */
export type FakeRule = readonly [match: string, responses: readonly FakeResponse[]];

export interface FakeGh {
  readonly directory: string;
  readonly bin: string;
  calls(): Promise<readonly (readonly string[])[]>;
  cleanup(): Promise<void>;
}

export async function fakeGh(rules: readonly FakeRule[]): Promise<FakeGh> {
  const directory = await mkdtemp(join(tmpdir(), "merge-gate-test-"));
  const bin = join(directory, "bin");
  const log = join(directory, "calls.ndjson");
  const counts = join(directory, "counts.json");
  await Bun.write(join(directory, "rules.json"), JSON.stringify(rules));
  await Bun.write(
    join(bin, "gh"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const rules = JSON.parse(readFileSync(${JSON.stringify(join(directory, "rules.json"))}, "utf8"));
const line = args.join(" ");
const index = rules.findIndex(([match]) => line.includes(match));
if (index < 0) {
  process.stderr.write("unexpected gh arguments: " + line + "\\n");
  process.exit(97);
}
const counts = existsSync(${JSON.stringify(counts)}) ? JSON.parse(readFileSync(${JSON.stringify(counts)}, "utf8")) : {};
const seen = counts[index] ?? 0;
counts[index] = seen + 1;
writeFileSync(${JSON.stringify(counts)}, JSON.stringify(counts));
const responses = rules[index][1];
const response = responses[Math.min(seen, responses.length - 1)];
if (response.stdout !== undefined)
  process.stdout.write(typeof response.stdout === "string" ? response.stdout : JSON.stringify(response.stdout));
if (response.stderr !== undefined) process.stderr.write(response.stderr);
process.exit(response.exit ?? 0);
`
  );
  await chmod(join(bin, "gh"), 0o755);
  return {
    directory,
    bin,
    async calls() {
      if (!existsSync(log)) return [];
      return (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line): string[] => JSON.parse(line));
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

