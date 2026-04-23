import { collectRange } from "../analyze/collect.js";
import { classifyDeadPaths, dropped as droppedShas } from "../analyze/dead-paths.js";
import { resolveTargetIdentity } from "../authorship/identity.js";
import type { StripPatterns } from "../authorship/patterns.js";
import { fallbackCluster } from "../cluster/fallback.js";
import type { ClusterInput } from "../cluster/schema.js";
import type { GitOptions } from "../git/shell.js";
import { asSha, type Commit, type Identity, type Sha } from "../git/types.js";
import type { Logger } from "../util/logger.js";
import { backupRefName, createBackup, workRefName } from "./backup.js";
import type { LockHandle } from "./lock.js";
import { preflight } from "./preflight.js";
import { promote } from "./promote.js";
import { reshape } from "./rebase.js";
import { rollback, type RollbackContext } from "./rollback.js";
import type { AppliedPlan, ApplyOutcome, PlannedCluster } from "./types.js";
import { verifyTreeEquality } from "./verify.js";

export interface ApplyRunOptions extends GitOptions {
  rangeSpec?: string;
  targetAuthor?: Identity;
  authorFlag?: string;
  allowDirty?: boolean;
  rewritePushed?: boolean;
  dryRun?: boolean;
  clusters?: PlannedCluster[];
  preserveAgentAttribution?: boolean;
  stripPatterns?: StripPatterns;
  preserveTrailerKeys?: readonly string[];
  logger?: Logger;
}

export async function runApply(opts: ApplyRunOptions = {}): Promise<ApplyOutcome> {
  const log = opts.logger;
  const { range, commits } = await collectRange({
    ...(opts.rangeSpec ? { rangeSpec: opts.rangeSpec } : {}),
    ...(opts.cwd ? { opts: { cwd: opts.cwd } } : {}),
  });

  const targetAuthor =
    opts.targetAuthor ??
    (await resolveTargetIdentity({
      ...(opts.authorFlag ? { authorFlag: opts.authorFlag } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }));
  const gitOptsForAnalysis: GitOptions = opts.cwd ? { cwd: opts.cwd } : {};

  let clusters: PlannedCluster[];
  let dropped: Sha[] = [];
  if (opts.clusters) {
    clusters = opts.clusters;
  } else {
    const deadReport = await classifyDeadPaths(range, commits, gitOptsForAnalysis);
    const inputs = fallbackCluster({ commits, byClassification: deadReport.byCommit });
    clusters = inputs.map((c) => clusterInputToPlanned(c));
    dropped = droppedShas(deadReport);
  }

  const plan: AppliedPlan = {
    range,
    clusters,
    dropped,
    targetAuthor,
  };

  if (opts.dryRun) {
    const dryNow = new Date();
    const lines = await formatDryRunCommands(plan, commits, dryNow);
    for (const l of lines) {
      if (log) log.info(l);
      else process.stdout.write(l + "\n");
    }
    return {
      backupRef: backupRefName(dryNow),
      newHead: plan.range.head,
      originalBranch: plan.range.headRef,
      clustersApplied: plan.clusters.length,
    };
  }

  const preOpts: Parameters<typeof preflight>[1] = {};
  if (opts.cwd) preOpts.cwd = opts.cwd;
  if (opts.allowDirty) preOpts.allowDirty = true;
  if (opts.rewritePushed) preOpts.rewritePushed = true;
  if (log) preOpts.logger = log;
  const { lock } = await preflight(plan, preOpts);
  const gitOpts: GitOptions = opts.cwd ? { cwd: opts.cwd } : {};

  const now = new Date();
  const backupRef = backupRefName(now);
  const workRef = workRefName(now);

  const ctx: RollbackContext = {
    backupRef,
    workRef: null,
    originalBranch: plan.range.headRef,
    promoted: false,
    lock,
    ...(log ? { logger: log } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  };

  installAbortHandlers(ctx);

  try {
    await createBackup(plan.range.headRef, now, gitOpts);
    log?.info(`backup: ${backupRef}`);

    ctx.workRef = workRef;
    await reshape(plan, workRef, {
      ...gitOpts,
      ...(log ? { logger: log } : {}),
      ...(opts.stripPatterns ? { stripPatterns: opts.stripPatterns } : {}),
      ...(opts.preserveTrailerKeys ? { preserveTrailerKeys: opts.preserveTrailerKeys } : {}),
      ...(opts.preserveAgentAttribution ? { preserveAgentAttribution: true } : {}),
    });
    log?.info(`reshape: ${plan.clusters.length} cluster(s) applied on ${workRef}`);

    await verifyTreeEquality(plan.range.head, workRef, gitOpts);
    log?.info("tree-equality: ok");

    await promote(plan.range.headRef, workRef, gitOpts);
    ctx.promoted = true;
    log?.info(`promoted: ${plan.range.headRef} → reshaped head`);

    lock.release();
    removeAbortHandlers();

    return {
      backupRef,
      newHead: plan.range.head,
      originalBranch: plan.range.headRef,
      clustersApplied: plan.clusters.length,
    };
  } catch (err) {
    await rollback(ctx);
    removeAbortHandlers();
    throw err;
  }
}

function clusterInputToPlanned(c: ClusterInput): PlannedCluster {
  const out: PlannedCluster = {
    id: c.id,
    type: c.type,
    subject: c.subject,
    memberShas: c.memberShas.map((s) => asSha(s)),
    preserveTrailers: ["Signed-off-by", "Reviewed-by", "Closes", "Fixes", "Refs", "Resolves"],
  };
  if (c.scope) out.scope = c.scope;
  if (c.body) out.body = c.body;
  return out;
}

export async function formatDryRunCommands(
  plan: AppliedPlan,
  commits: readonly Commit[],
  now: Date = new Date(),
): Promise<string[]> {
  const out: string[] = [];
  const backup = backupRefName(now);
  const work = workRefName(now);
  const REDACTED = "<configured author>";

  out.push(`# atropos dry-run — would run the following:`);
  out.push("");
  out.push(`# preflight (read-only)`);
  out.push(`git status --porcelain`);
  out.push(`git for-each-ref --format='%(refname)' refs/remotes`);
  out.push(`git rev-parse --verify ${plan.range.headRef}`);
  out.push("");
  out.push(`# backup ref before any mutation`);
  out.push(`git branch ${backup} ${plan.range.headRef}`);
  out.push("");
  out.push(`# scratch work branch from base`);
  out.push(`git checkout -b ${work} ${plan.range.base}`);

  const memberByMember = new Map<string, Commit>();
  for (const c of commits) memberByMember.set(String(c.sha), c);

  for (let i = 0; i < plan.clusters.length; i++) {
    const cluster = plan.clusters[i]!;
    const subject = cluster.scope
      ? `${cluster.type}(${cluster.scope}): ${cluster.subject}`
      : `${cluster.type}: ${cluster.subject}`;
    out.push("");
    out.push(`# cluster ${cluster.id} (${i + 1}/${plan.clusters.length}): ${subject}`);
    for (const sha of cluster.memberShas) {
      out.push(`git cherry-pick -n --allow-empty --keep-redundant-commits ${sha}`);
    }
    const earliestDate = earliestDateForCluster(cluster.memberShas, memberByMember);
    out.push(
      [
        `GIT_AUTHOR_NAME="${REDACTED}"`,
        `GIT_AUTHOR_EMAIL="${REDACTED}"`,
        `GIT_AUTHOR_DATE="${earliestDate}"`,
        `GIT_COMMITTER_NAME="${REDACTED}"`,
        `GIT_COMMITTER_EMAIL="${REDACTED}"`,
        `git commit --no-verify --no-gpg-sign --allow-empty -m ${shellQuote(subject)}`,
      ].join(" \\\n  "),
    );
  }

  out.push("");
  out.push(`# tree-equality gate (the non-negotiable safety check)`);
  out.push(`test "$(git rev-parse ${work}^{tree})" = "$(git rev-parse ${plan.range.head}^{tree})"`);

  out.push("");
  out.push(`# promote: move branch ref, switch, drop the work branch`);
  out.push(`git branch -f ${plan.range.headRef} ${work}`);
  out.push(`git checkout ${plan.range.headRef}`);
  out.push(`git branch -D ${work}`);
  out.push("");
  out.push(`# atropos will NOT push. Next step is yours:`);
  out.push(`# git push --force-with-lease`);

  return out;
}

function earliestDateForCluster(
  memberShas: readonly string[],
  byMember: Map<string, Commit>,
): string {
  const dates: string[] = [];
  for (const sha of memberShas) {
    const c = byMember.get(sha);
    if (c) dates.push(c.authoredAt);
  }
  if (dates.length === 0) return new Date().toISOString();
  return dates.reduce((a, b) => (a < b ? a : b));
}

function shellQuote(s: string): string {
  if (!/[\s"'$`\\!]/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

let activeCtx: RollbackContext | null = null;
const abortHandler = (sig: NodeJS.Signals): void => {
  if (!activeCtx) return;
  const ctx = activeCtx;
  activeCtx = null;
  void rollback(ctx).finally(() => {
    process.stderr.write(`\natropos: rolled back after ${sig}\n`);
    process.exit(130);
  });
};

function installAbortHandlers(ctx: RollbackContext): void {
  activeCtx = ctx;
  process.on("SIGINT", abortHandler);
  process.on("SIGTERM", abortHandler);
}

function removeAbortHandlers(): void {
  activeCtx = null;
  process.off("SIGINT", abortHandler);
  process.off("SIGTERM", abortHandler);
}
