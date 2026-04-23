import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runApply } from "../apply/run.js";
import { asSha } from "../git/types.js";
import { gitTopLevel } from "../git/guards.js";
import type { PlannedCluster } from "../apply/types.js";
import { parsePlan } from "../plan/parse.js";
import { assertPlanIsFresh } from "../plan/validate-plan.js";
import { AtroposError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import { PLAN_DEFAULT_PATH } from "./reshape.js";

export interface ApplyCliOptions {
  range?: string;
  dryRun?: boolean;
  allowDirty?: boolean;
  rewritePushed?: boolean;
  author?: string;
  preserveAgentAttribution?: boolean;
  planPath?: string;
  logger: Logger;
}

export async function applyCommand(opts: ApplyCliOptions): Promise<number> {
  const planPath = await resolvePlanPath(opts.planPath);
  if (!existsSync(planPath)) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: `plan file not found at ${planPath}`,
      fix: "run `atropos` first to generate a plan, or pass `--plan <path>`",
    });
  }
  const planSrc = readFileSync(planPath, "utf8");
  const plan = parsePlan(planSrc);
  await assertPlanIsFresh(plan, {});

  const runOpts: Parameters<typeof runApply>[0] = {
    logger: opts.logger,
    targetAuthor: plan.authorship.targetAuthor,
    clusters: plan.clusters.map(toPlannedCluster),
  };
  if (opts.dryRun) runOpts.dryRun = true;
  if (opts.allowDirty) runOpts.allowDirty = true;
  if (opts.rewritePushed) runOpts.rewritePushed = true;
  if (opts.author) runOpts.authorFlag = opts.author;
  if (opts.preserveAgentAttribution) runOpts.preserveAgentAttribution = true;

  const result = await runApply(runOpts);
  if (opts.dryRun) {
    opts.logger.info(`dry-run complete: ${result.clustersApplied} cluster(s)`);
    return 0;
  }
  opts.logger.info(`done — backup: ${result.backupRef}`);
  opts.logger.info(`next step is yours: git push --force-with-lease`);
  return 0;
}

async function resolvePlanPath(override?: string): Promise<string> {
  if (override) return override;
  try {
    return join(await gitTopLevel({}), PLAN_DEFAULT_PATH);
  } catch {
    return join(process.cwd(), PLAN_DEFAULT_PATH);
  }
}

function toPlannedCluster(c: import("../cluster/schema.js").ClusterInput): PlannedCluster {
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
