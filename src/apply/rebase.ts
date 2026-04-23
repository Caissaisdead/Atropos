import { reportClusterAuthorship } from "../authorship/report.js";
import type { StripPatterns } from "../authorship/patterns.js";
import { git, gitRaw, type GitOptions } from "../git/shell.js";
import { readCommits } from "../git/commits.js";
import type { Commit } from "../git/types.js";
import { AtroposError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import {
  composeMessage,
  earliestAuthoredAt,
  writeCommit,
} from "./commit-writer.js";
import type { AppliedPlan, PlannedCluster } from "./types.js";

export interface ReshapeOptions extends GitOptions {
  logger?: Logger;
  stripPatterns?: StripPatterns;
  preserveTrailerKeys?: readonly string[];
  preserveAgentAttribution?: boolean;
}

export async function checkoutWorkBranch(
  workRef: string,
  base: string,
  opts: GitOptions = {},
): Promise<void> {
  await git(["checkout", "-q", "-b", workRef, base], opts);
}

export async function cherryPickAndCommit(
  cluster: PlannedCluster,
  plan: AppliedPlan,
  opts: ReshapeOptions = {},
): Promise<void> {
  const members = await readCommits(cluster.memberShas, opts);

  for (const sha of cluster.memberShas) {
    const r = await gitRaw(
      [
        "cherry-pick",
        "-n",
        "--allow-empty",
        "--keep-redundant-commits",
        sha,
      ],
      opts,
    );
    if (r.exitCode !== 0) {
      // cherry-pick -n leaves unmerged entries in the index and conflict markers
      // in the worktree even after --abort. Reset hard to restore work-ref state
      // so rollback can checkout cleanly.
      await gitRaw(["cherry-pick", "--abort"], opts);
      await gitRaw(["reset", "--hard", "HEAD"], opts);
      throw new AtroposError({
        code: "ERR_CONFLICT",
        what: `cherry-pick of ${sha.slice(0, 8)} failed`,
        why: r.stderr.trim() || "non-zero exit from git cherry-pick",
        fix: "resolve the conflict in source commits, regenerate the plan, then re-run apply",
      });
    }
  }

  const preserveTrailers = opts.preserveAgentAttribution
    ? dedupTrailers(members.flatMap((m) => m.trailers))
    : reportClusterAuthorship(members, {
        ...(opts.stripPatterns ? { patterns: opts.stripPatterns } : {}),
        ...(opts.preserveTrailerKeys ? { preserveTrailerKeys: opts.preserveTrailerKeys } : {}),
      }).preservedTrailers;

  const message = composeMessage({ cluster, members, preserveTrailers });
  const target = plan.targetAuthor;

  await writeCommit(
    {
      message,
      author: target,
      authorDate: earliestAuthoredAt(members),
      committer: target,
      allowEmpty: true,
    },
    opts,
  );
}

function dedupTrailers(trailers: readonly Commit["trailers"][number][]): Commit["trailers"] {
  const seen = new Set<string>();
  const out: Commit["trailers"] = [];
  for (const t of trailers) {
    const key = `${t.key}:${t.value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export async function reshape(
  plan: AppliedPlan,
  workRef: string,
  opts: ReshapeOptions = {},
): Promise<void> {
  await checkoutWorkBranch(workRef, plan.range.base, opts);
  for (const cluster of plan.clusters) {
    await cherryPickAndCommit(cluster, plan, opts);
  }
}

// degenerateClustersFrom is retained as a low-level helper but no longer used
// in the apply path now that fallbackCluster() runs by default.

export function degenerateClustersFrom(commits: readonly Commit[]): PlannedCluster[] {
  return commits.map((c, i) => {
    const cluster: PlannedCluster = {
      id: `c${i + 1}`,
      type: "chore",
      subject: c.subject || `commit ${c.sha.slice(0, 7)}`,
      memberShas: [c.sha],
      preserveTrailers: ["Signed-off-by", "Reviewed-by", "Closes", "Fixes", "Refs", "Resolves"],
    };
    if (c.body && c.body.trim().length > 0) cluster.body = c.body.trim();
    return cluster;
  });
}
