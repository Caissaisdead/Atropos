import { lsTree } from "../git/commits.js";
import {
  assertCleanTree,
  assertInRepo,
  assertNoMergeOrRebase,
  assertSupportedRepoLayout,
} from "../git/guards.js";
import { isAncestor, listRemoteTrackingRefs, revParse } from "../git/refs.js";
import type { GitOptions } from "../git/shell.js";
import type { Sha } from "../git/types.js";
import { AtroposError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import { acquireLock, type LockHandle } from "./lock.js";
import type { AppliedPlan } from "./types.js";

export interface PreflightOptions extends GitOptions {
  allowDirty?: boolean;
  rewritePushed?: boolean;
  logger?: Logger;
}

export interface PreflightResult {
  lock: LockHandle;
  rangeShas: Set<Sha>;
}

export async function preflight(
  plan: AppliedPlan,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  await assertInRepo(opts);
  await assertSupportedRepoLayout(opts);
  await assertNoMergeOrRebase(opts);
  if (!opts.allowDirty) await assertCleanTree(opts);

  const headSha = await revParse(plan.range.headRef, opts);
  if (headSha !== plan.range.head) {
    throw new AtroposError({
      code: "ERR_DIRTY",
      what: `HEAD has moved since the plan was generated`,
      why: `expected ${plan.range.head}, got ${headSha}`,
      fix: "regenerate the plan, then re-run apply",
    });
  }

  const rangeShas = new Set<Sha>(plan.clusters.flatMap((c) => c.memberShas));

  if (!opts.rewritePushed && rangeShas.size > 0) {
    await assertRangeUnpushed(rangeShas, opts);
  }

  const headTree = await lsTree(plan.range.head, opts);
  if (headTree.size === 0) {
    opts.logger?.warn("head tree is empty — proceeding but verify will be a no-op");
  }

  const lock = await acquireLock(opts);
  return { lock, rangeShas };
}

async function assertRangeUnpushed(
  rangeShas: Set<Sha>,
  opts: GitOptions,
): Promise<void> {
  const refs = await listRemoteTrackingRefs(undefined, opts);
  for (const sha of rangeShas) {
    for (const r of refs) {
      if (await isAncestor(sha, r.ref, opts)) {
        throw new AtroposError({
          code: "ERR_PUSHED",
          what: `commit ${sha.slice(0, 8)} is reachable from ${r.ref}`,
          why: "atropos refuses to rewrite commits that exist on a remote",
          fix: "pass `--rewrite-pushed` if you really mean to do this",
        });
      }
    }
  }
}
