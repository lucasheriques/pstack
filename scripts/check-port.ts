#!/usr/bin/env bun
// Flags Cursor-isms the Claude Code port must translate, plus the port's own
// invariants (see translation.md). Run before every commit and after every upstream merge.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const principlesDirectory = join(repoRoot, "skills/poteto-mode/principles");
const pstackNames = new Set([
  ...readdirSync(join(repoRoot, "skills")),
  ...readdirSync(join(repoRoot, "agents")).map(
    (file) => /^name: (.+)$/m.exec(readFileSync(join(repoRoot, "agents", file), "utf8"))?.[1],
  ),
]);

type Rule = {
  name: string;
  pattern: RegExp;
  exemptPaths?: RegExp;
  paths?: RegExp;
};

const rules: Rule[] = [
  { name: "cursor-path", pattern: /\.cursor\/|\.mdc\b|agent-transcripts/ },
  { name: "cursor-brand", pattern: /\bCursor\b/ },
  { name: "cursor-team-kit", pattern: /cursor-team-kit|\bdeslop\b|\bcontrol-(ui|cli)\b/ },
  {
    name: "cursor-tool",
    pattern: /\bAskQuestion\b|\bTask (tool|call|calls|subagent)\b|`Task`|generalPurpose|is_background|environment: "(cloud|local)"|\bcloud_base_branch\b|\bShell tool\b/,
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
  { name: "plugin-version", pattern: /"version"\s*:/, paths: /^\.claude-plugin\// },
  { name: "cursor-bugbot", pattern: /\bbugbot\b(?!-triage)/i, exemptPaths: /\.ts$/ },
];

const exemptFiles = /^(README\.md|LICENSE|scripts\/check-port(\.test)?\.ts|\.claude\/)/;

export type Finding = { path: string; line: number; rule: string; text: string };

function unresolvedSkillPaths(path: string, text: string): string[] {
  const skillDirectory = /^skills\/[^/]+/.exec(path)?.[0];
  if (skillDirectory === undefined) return [];
  return [...text.matchAll(/\$\{CLAUDE_SKILL_DIR\}(\/[^\s`'")]*)/g)]
    .map(([, relative]) => relative.replace(/[.,:;]+$/, ""))
    .filter((relative) => !/[<*]/.test(relative))
    .filter((relative) => !existsSync(join(repoRoot, skillDirectory, relative)));
}

function unresolvedPstackNames(text: string): string[] {
  return [...text.matchAll(/\bpstack:([a-z][a-z-]*[a-z])/g)]
    .map(([, name]) => name)
    .filter((name) => !pstackNames.has(name));
}

function unresolvedPrinciples(text: string): string[] {
  return [...text.matchAll(/\bprinciple-[a-z-]*[a-z]/g)]
    .map(([name]) => name)
    .filter((name) => !existsSync(join(principlesDirectory, `${name}.md`)));
}

export function findingsFor(path: string, text: string): Finding[] {
  if (exemptFiles.test(path)) return [];
  return text.split("\n").flatMap((lineText, index) => {
    const ruleHits = rules
      .filter((rule) => (rule.paths?.test(path) ?? true) && !rule.exemptPaths?.test(path) && rule.pattern.test(lineText))
      .map((rule) => rule.name);
    const referenceHits = [
      ...unresolvedPrinciples(lineText).map(() => "unresolved-principle"),
      ...unresolvedSkillPaths(path, lineText).map(() => "unresolved-skill-path"),
      ...unresolvedPstackNames(lineText).map(() => "unresolved-pstack-name"),
    ];
    return [...ruleHits, ...referenceHits].map((rule) => ({
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
    .filter((path) => /\.(md|ts|mjs|sh|json|tsv)$|\/watch-pr$/.test(path) && !path.endsWith("bun.lock"))
    .filter((path) => existsSync(join(repoRoot, path)));
}

if (import.meta.main) {
  const findings = trackedTextFiles().flatMap((path) =>
    findingsFor(path, readFileSync(join(repoRoot, path), "utf8")),
  );
  for (const { path, line, rule, text } of findings) console.log(`${path}:${line} [${rule}] ${text}`);
  console.log(`${findings.length} finding(s)`);
  process.exit(findings.length === 0 ? 0 : 1);
}
