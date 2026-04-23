import { topDir } from "../analyze/net-diff.js";
import type { NetDiffReport } from "../analyze/net-diff.js";
import type { CommitClassification } from "../analyze/dead-paths.js";
import { git, type GitOptions } from "../git/shell.js";
import type { Commit, Range, Sha } from "../git/types.js";
import {
  estimateTokens,
  PER_COMMIT_DIFF_LINE_CAP,
  PER_RANGE_DIFF_LINE_CAP,
  TOKEN_LIMIT_HARD,
} from "../util/tokens.js";
import { COMMIT_TYPES } from "./schema.js";

export const SYSTEM_PROMPT = `\
You reshape messy agent-generated git history into clean, reviewable commits.
You output ONLY a single JSON object conforming to the schema given below.
No prose, no code fences, no commentary.

Invariants you MUST obey:
- Every LIVE or MIXED commit in the range MUST appear in exactly one cluster's
  memberShas, OR in the dropped list. No commit may be in both. None may be omitted.
- Every sha you emit MUST come from the provided commits. Do NOT invent shas.
- Cluster order is apply order. A cluster that depends on paths created by another
  must come after it.
- Subjects: ≤ 72 chars, imperative, no trailing period, lowercase after the type.
- Do NOT include Co-authored-by, Signed-off-by, or "Generated with" lines in any
  cluster body. A separate authorship pass handles those.
- Allowed types: ${COMMIT_TYPES.join(", ")}.
`;

export const SCHEMA_HINT = `\
The Plan you must produce conforms to this JSON shape:
{
  "clusters": [
    {
      "id": "c1",                       // tool reassigns these; any string ok
      "type": "feat|fix|refactor|chore|test|docs|perf|build|ci",
      "scope": "optional short scope",  // omit if none
      "subject": "short imperative subject (≤72 chars, no trailing period)",
      "body": "optional multi-paragraph body",
      "memberShas": ["<sha>", ...],     // ≥1 sha from provided commits
      "reasoning": "why this grouping",
      "confidence": 0.0-1.0
    }
  ],
  "dropped": [
    { "sha": "<sha>", "reason": "why this commit is dead" }
  ],
  "warnings": ["optional analyst notes"]
}
Output exactly this JSON object — no surrounding markdown, no leading text.`;

export interface BuildPromptInput {
  range: Range;
  commits: readonly Commit[];
  byClassification: Map<Sha, CommitClassification>;
  netDiff: NetDiffReport;
  opts?: GitOptions;
}

export interface BuiltPrompt {
  systemText: string;
  schemaText: string;
  variableText: string;
  /** True if diffs were dropped wholesale due to the hard token cap. */
  diffsDropped: boolean;
  /** Approximate token count of the variable section (for accounting). */
  estimatedTokens: number;
}

export async function buildPrompt(input: BuildPromptInput): Promise<BuiltPrompt> {
  const lines: string[] = [];
  lines.push(`<range>`);
  lines.push(`  base: ${input.range.base} (${input.range.baseRef})`);
  lines.push(`  head: ${input.range.head} (${input.range.headRef})`);
  lines.push(`  commits in range: ${input.commits.length}`);
  const dropCount = countByClass(input.byClassification, "DROP");
  if (dropCount > 0) {
    lines.push(`  dead-path full-drop commits already filtered: ${dropCount}`);
  }
  lines.push(`</range>`);
  lines.push("");
  lines.push(`<net_diff>`);
  lines.push(
    `  files changed: ${input.netDiff.filesChanged}, +${input.netDiff.added} -${input.netDiff.deleted}`,
  );
  lines.push(`  areas:`);
  for (const a of input.netDiff.areas.slice(0, 8)) {
    lines.push(`    - ${a.topDir}/  +${a.added} -${a.deleted} (${a.files} files)`);
  }
  lines.push(`</net_diff>`);
  lines.push("");

  // Build commit blocks. Compute total diff lines first to enforce per-range cap.
  const liveCommits = input.commits.filter(
    (c) => input.byClassification.get(c.sha)?.classification !== "DROP",
  );

  const diffsByCommit = new Map<Sha, { text: string; truncated: boolean }>();
  let runningRangeLines = 0;
  for (const c of liveCommits) {
    const diff = await readCommitDiff(c.sha, input.opts ?? {});
    const diffLines = diff.split("\n");
    let used = diffLines;
    let truncated = false;
    if (used.length > PER_COMMIT_DIFF_LINE_CAP) {
      used = used.slice(0, PER_COMMIT_DIFF_LINE_CAP);
      truncated = true;
    }
    const remainingRange = PER_RANGE_DIFF_LINE_CAP - runningRangeLines;
    if (remainingRange <= 0) {
      diffsByCommit.set(c.sha, { text: "[…elided due to range diff cap…]", truncated: true });
      continue;
    }
    if (used.length > remainingRange) {
      used = used.slice(0, remainingRange);
      truncated = true;
    }
    runningRangeLines += used.length;
    const text = truncated
      ? `${used.join("\n")}\n[…truncated to ${used.length} lines…]`
      : used.join("\n");
    diffsByCommit.set(c.sha, { text, truncated });
  }

  lines.push(`<commits>`);
  for (const c of liveCommits) {
    const classification = input.byClassification.get(c.sha)?.classification ?? "LIVE";
    const fileSummary = c.files
      .slice(0, 12)
      .map((f) => `${f.path} (${f.status} +${f.added} -${f.deleted})`)
      .join(", ");
    const dirHint = uniq(c.files.map((f) => topDir(f.path))).join(",");
    lines.push(`  <commit sha="${c.sha}" status="${classification}" topdirs="${dirHint}">`);
    lines.push(`    <message>${escapeXml(c.subject)}${c.body ? `\n${escapeXml(c.body)}` : ""}</message>`);
    lines.push(`    <files>${fileSummary}${c.files.length > 12 ? ", …" : ""}</files>`);
    const diff = diffsByCommit.get(c.sha);
    lines.push(`    <diff truncated="${diff?.truncated ? "true" : "false"}">`);
    lines.push(diff?.text ?? "");
    lines.push(`    </diff>`);
    lines.push(`  </commit>`);
  }
  lines.push(`</commits>`);
  lines.push("");
  lines.push(`<instructions>`);
  lines.push(`Group LIVE and MIXED commits into clusters. Output the JSON Plan now.`);
  lines.push(`</instructions>`);

  let variableText = lines.join("\n");
  let estimatedTokens = estimateTokens(variableText);
  let diffsDropped = false;
  if (estimatedTokens > TOKEN_LIMIT_HARD) {
    variableText = stripDiffSections(variableText);
    diffsDropped = true;
    estimatedTokens = estimateTokens(variableText);
  }

  return {
    systemText: SYSTEM_PROMPT,
    schemaText: SCHEMA_HINT,
    variableText,
    diffsDropped,
    estimatedTokens,
  };
}

async function readCommitDiff(sha: string, opts: GitOptions): Promise<string> {
  return git(["show", "--no-color", "--format=", sha], opts);
}

function countByClass(
  byClassification: Map<Sha, CommitClassification>,
  cls: CommitClassification["classification"],
): number {
  let n = 0;
  for (const [, c] of byClassification) if (c.classification === cls) n += 1;
  return n;
}

function uniq(arr: readonly string[]): string[] {
  return Array.from(new Set(arr));
}

function escapeXml(s: string): string {
  return s.replace(/[&<>]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;",
  );
}

function stripDiffSections(text: string): string {
  return text.replace(/<diff[^>]*>[\s\S]*?<\/diff>/g, "<diff truncated=\"true\">[…elided to fit token budget…]</diff>");
}
