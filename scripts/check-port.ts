#!/usr/bin/env bun
// Flags Cursor-isms that the Claude Code port must translate. Run after every
// upstream merge: each finding is a line that still assumes Cursor's harness.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const principlesDirectory = join(repoRoot, "skills/poteto-mode/principles");

type Rule = {
  name: string;
  pattern: RegExp;
  exemptPaths?: RegExp;
};

const rules: Rule[] = [
  { name: "cursor-path", pattern: /\.cursor\/|\.mdc\b|agent-transcripts/ },
  { name: "cursor-brand", pattern: /\bCursor\b/ },
  { name: "cursor-team-kit", pattern: /cursor-team-kit|\bdeslop\b|\bcontrol-(ui|cli)\b/ },
  {
    name: "cursor-tool",
    pattern: /\bAskQuestion\b|\bTask (tool|call|calls|subagent)\b|`Task`|generalPurpose|is_background/,
  },
  {
    name: "cursor-tool",
    pattern: /\breadonly\b/,
    exemptPaths: /^skills\/typescript-best-practices\/|\.ts$/,
  },
  { name: "non-claude-model", pattern: /\bgrok\b|\bgrok-|\bgpt-|sol-max|\bcomposer-|\bgemini\b|\bcodex\b|\bkimi\b/i },
  { name: "cursor-model-slug", pattern: /claude-[a-z]+-\d-\d-(max|xhigh|high|medium|low)|inherit-parent/ },
  { name: "origin-forge", pattern: /\borigin pr\b|\bOrigin\b/ },
  { name: "cursor-cloud-agent", pattern: /\bcloud[- ]agents?\b/i },
  { name: "cursor-frontmatter", pattern: /^(mode|reminder|icon|color): /m },
  { name: "cursor-builtin-skill", pattern: /\bcreate-skill\b|\bsetup-pstack\b|\bmake-bot-ui\b/ },
  { name: "cursor-bugbot", pattern: /\bbugbot\b(?!-triage)/i, exemptPaths: /\.ts$/ },
];

const exemptFiles = /^(README\.md|LICENSE|scripts\/check-port(\.test)?\.ts|\.claude\/)/;

export type Finding = { path: string; line: number; rule: string; text: string };

function unresolvedPrinciples(text: string): string[] {
  return [...text.matchAll(/\bprinciple-[a-z-]*[a-z]/g)]
    .map(([name]) => name)
    .filter((name) => !existsSync(join(principlesDirectory, `${name}.md`)));
}

export function findingsFor(path: string, text: string): Finding[] {
  if (exemptFiles.test(path)) return [];
  return text.split("\n").flatMap((lineText, index) => {
    const ruleHits = rules
      .filter((rule) => !rule.exemptPaths?.test(path) && rule.pattern.test(lineText))
      .map((rule) => rule.name);
    const principleHits = unresolvedPrinciples(lineText).map(() => "unresolved-principle");
    return [...ruleHits, ...principleHits].map((rule) => ({
      path,
      line: index + 1,
      rule,
      text: lineText.trim().slice(0, 160),
    }));
  });
}

function trackedTextFiles(): string[] {
  const listing = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
  });
  return listing.stdout
    .toString()
    .split("\n")
    .filter((path) => /\.(md|ts|mjs|sh|json|tsv)$|\/watch-pr$/.test(path) && !path.endsWith("bun.lock"));
}

if (import.meta.main) {
  const findings = trackedTextFiles().flatMap((path) =>
    findingsFor(path, readFileSync(join(repoRoot, path), "utf8")),
  );
  for (const { path, line, rule, text } of findings) console.log(`${path}:${line} [${rule}] ${text}`);
  console.log(`${findings.length} finding(s)`);
  process.exit(findings.length === 0 ? 0 : 1);
}
