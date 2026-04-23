import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitDir } from "../git/guards.js";
import { collectRange } from "../analyze/collect.js";
import {
  classifyDeadPaths,
  dropped as droppedShas,
  liveOrMixed,
} from "../analyze/dead-paths.js";
import { netDiff } from "../analyze/net-diff.js";
import { resolveTargetIdentity } from "../authorship/identity.js";
import { reportClusterAuthorship } from "../authorship/report.js";
import { fallbackCluster } from "../cluster/fallback.js";
import { buildPrompt } from "../cluster/prompt.js";
import type { ClusterInput, PlanDocument } from "../cluster/schema.js";
import { gitTopLevel } from "../git/guards.js";
import { readCommits } from "../git/commits.js";
import type { LlmClient } from "../cluster/llm.js";
import type { GitOptions } from "../git/shell.js";
import { renderPlan } from "../plan/render.js";
import type { Logger } from "../util/logger.js";

export interface ReshapeCliOptions {
  range?: string;
  output?: string;
  author?: string;
  noCloud?: boolean;
  model?: string;
  /** Override LLM client (test injection). If set, bypasses the dynamic SDK import. */
  llmClient?: LlmClient;
  logger: Logger;
}

const DEFAULT_PLAN_PATH = ".atropos/plan.md";

export async function reshapeCommand(opts: ReshapeCliOptions): Promise<number> {
  const log = opts.logger;
  const gitOpts: GitOptions = {};

  log.info(`Collecting range${opts.range ? ` (${opts.range})` : ""}…`);
  const collected = await collectRange(opts.range ? { rangeSpec: opts.range } : {});
  log.info(`  ${collected.commits.length} commits`);

  const deadReport = await classifyDeadPaths(collected.range, collected.commits, gitOpts);
  const dropped = droppedShas(deadReport);
  log.info(`Dead-path analysis: ${deadReport.deadFiles.size} dead-in-range files, ${dropped.length} full-drop commits`);

  let clusterInputs: ClusterInput[];
  let extraDropped: Array<{ sha: string; reason: string }> = [];
  const warnings: string[] = [];
  let modelUsed: string | undefined;

  const llmAttempt = await tryLlmCluster(opts, collected, deadReport, log);
  if (llmAttempt) {
    clusterInputs = llmAttempt.clusters;
    extraDropped = llmAttempt.dropped;
    warnings.push(...llmAttempt.warnings);
    modelUsed = llmAttempt.model;
    log.info(
      `Clustering: ${clusterInputs.length} cluster(s) via ${llmAttempt.model} (cost≈$${llmAttempt.estimatedCostUsd.toFixed(4)})`,
    );
  } else {
    clusterInputs = fallbackCluster({
      commits: collected.commits,
      byClassification: deadReport.byCommit,
    });
    const llmAvailable = !opts.noCloud && (opts.llmClient || process.env["ANTHROPIC_API_KEY"]);
    if (llmAvailable) {
      warnings.push("LLM clustering failed; fell back to heuristic clustering");
    }
    log.info(`Clustering: ${clusterInputs.length} cluster(s) (heuristic, no LLM)`);
  }

  const targetAuthor = await resolveTargetIdentity({
    ...(opts.author ? { authorFlag: opts.author } : {}),
  });

  const aggregate = await aggregateAuthorship(clusterInputs, gitOpts);

  if (collected.mergeCount > 0) {
    warnings.push(`${collected.mergeCount} merge commit(s) skipped (--include-merges not in v1)`);
  }

  const plan: PlanDocument = {
    version: 1,
    range: collected.range,
    generatedAt: new Date().toISOString(),
    clusters: clusterInputs,
    dropped: [
      ...dropped.map((sha) => ({
        sha,
        reason: deadReport.byCommit.get(sha)?.deadFiles.length
          ? `commit only touches dead paths: ${(deadReport.byCommit.get(sha)?.deadFiles ?? []).join(", ")}`
          : "dropped",
      })),
      ...extraDropped,
    ],
    warnings,
    authorship: {
      targetAuthor,
      strippedSummary: aggregate.stripped,
      preservedSummary: aggregate.preserved,
    },
  };
  if (modelUsed) plan.model = modelUsed;

  const outputPath = await resolveOutputPath(opts.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  const rendered = renderPlan({ plan, totalCommitsInRange: collected.commits.length });
  writeFileSync(outputPath, rendered, "utf8");
  await ensureLocalExclude(".atropos/");

  log.info(`Wrote plan to ${outputPath}`);
  log.info(`${collected.commits.length} commits → ${plan.clusters.length} commits (${plan.dropped.length} dropped)`);
  log.info(`Review the plan, then: atropos apply`);
  return 0;
}

interface LlmAttempt {
  clusters: ClusterInput[];
  dropped: Array<{ sha: string; reason: string }>;
  warnings: string[];
  model: string;
  estimatedCostUsd: number;
}

async function tryLlmCluster(
  opts: ReshapeCliOptions,
  collected: Awaited<ReturnType<typeof collectRange>>,
  deadReport: Awaited<ReturnType<typeof classifyDeadPaths>>,
  log: Logger,
): Promise<LlmAttempt | null> {
  if (opts.noCloud) return null;
  if (!opts.llmClient && !process.env["ANTHROPIC_API_KEY"]) {
    log.info("ANTHROPIC_API_KEY not set; skipping LLM, using heuristic");
    return null;
  }

  // Dynamic import — keeps the SDK out of the bundle path when --no-cloud is set.
  const llm = await import("../cluster/llm.js");

  try {
    const nd = await netDiff(collected.range, {});
    const prompt = await buildPrompt({
      range: collected.range,
      commits: collected.commits,
      byClassification: deadReport.byCommit,
      netDiff: nd,
      opts: {},
    });
    if (prompt.diffsDropped) {
      log.warn("prompt exceeded token cap; diffs elided — clustering will be coarser");
    }

    const result = await llm.clusterWithLLM({
      prompt,
      liveOrMixedShas: liveOrMixed(deadReport),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.llmClient ? { client: opts.llmClient } : {}),
      logger: log,
    });

    const out: LlmAttempt = {
      clusters: result.clusters,
      dropped: result.dropped,
      warnings: result.warnings,
      model: opts.model ?? llm.DEFAULT_MODEL,
      estimatedCostUsd: result.estimatedCostUsd,
    };
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`LLM clustering failed: ${msg}`);
    return null;
  }
}

async function resolveOutputPath(override?: string): Promise<string> {
  if (override) return override;
  let top: string;
  try {
    top = await gitTopLevel({});
  } catch {
    top = process.cwd();
  }
  return join(top, DEFAULT_PLAN_PATH);
}

async function ensureLocalExclude(entry: string): Promise<void> {
  let dir: string;
  try {
    dir = await gitDir({});
  } catch {
    return;
  }
  const cwd = process.cwd();
  const fullDir = dir.startsWith("/") ? dir : join(cwd, dir);
  const excludePath = join(fullDir, "info", "exclude");
  let current = "";
  if (existsSync(excludePath)) {
    current = readFileSync(excludePath, "utf8");
    const lines = current.split("\n").map((l) => l.trim());
    if (lines.includes(entry)) return;
  }
  try {
    mkdirSync(dirname(excludePath), { recursive: true });
    const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, `${current}${sep}${entry}\n`, "utf8");
  } catch {
    // Best-effort; if .git/info/exclude isn't writable, the user can gitignore it themselves.
  }
}

async function aggregateAuthorship(
  clusters: readonly ClusterInput[],
  opts: GitOptions,
): Promise<{
  stripped: Array<{ pattern: string; count: number }>;
  preserved: Array<{ key: string; count: number }>;
}> {
  const stripCounts = new Map<string, number>();
  const preserveCounts = new Map<string, number>();
  for (const c of clusters) {
    const members = await readCommits(c.memberShas, opts);
    const report = reportClusterAuthorship(members);
    for (const s of report.stripStats) {
      stripCounts.set(s.pattern, (stripCounts.get(s.pattern) ?? 0) + s.count);
    }
    for (const p of report.preserveStats) {
      preserveCounts.set(p.key, (preserveCounts.get(p.key) ?? 0) + p.count);
    }
  }
  return {
    stripped: Array.from(stripCounts, ([pattern, count]) => ({ pattern, count })),
    preserved: Array.from(preserveCounts, ([key, count]) => ({ key, count })),
  };
}

export const PLAN_DEFAULT_PATH = DEFAULT_PLAN_PATH;
