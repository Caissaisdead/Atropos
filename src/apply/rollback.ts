import { gitRaw, type GitOptions } from "../git/shell.js";
import type { Logger } from "../util/logger.js";
import type { LockHandle } from "./lock.js";

export interface RollbackContext {
  backupRef: string;
  workRef: string | null;
  originalBranch: string;
  promoted: boolean;
  lock: LockHandle | null;
  logger?: Logger;
  cwd?: string;
}

export async function rollback(ctx: RollbackContext): Promise<void> {
  const opts: GitOptions = ctx.cwd ? { cwd: ctx.cwd } : {};
  const log = ctx.logger;

  await gitRaw(["cherry-pick", "--abort"], opts).catch(() => undefined);
  await gitRaw(["merge", "--abort"], opts).catch(() => undefined);
  // Defensive: scrub any lingering unmerged entries / partial cherry-pick state
  // on whatever branch we're currently on (typically the work ref).
  await gitRaw(["reset", "--hard", "HEAD"], opts).catch(() => undefined);

  const onBranch = await currentBranchOrNull(opts);
  const targetBranch = ctx.promoted ? ctx.originalBranch : null;

  if (targetBranch && onBranch !== targetBranch) {
    const co = await gitRaw(["checkout", "-q", targetBranch], opts);
    if (co.exitCode !== 0) {
      log?.warn(`rollback: failed to checkout ${targetBranch} — ${co.stderr.trim()}`);
    }
  } else if (!targetBranch && onBranch === ctx.workRef) {
    const co = await gitRaw(["checkout", "-q", ctx.originalBranch], opts);
    if (co.exitCode !== 0) {
      log?.warn(`rollback: failed to leave work branch — ${co.stderr.trim()}`);
    }
  }

  if (ctx.promoted) {
    const restore = await gitRaw(
      ["branch", "-f", ctx.originalBranch, ctx.backupRef],
      opts,
    );
    if (restore.exitCode !== 0) {
      log?.error(
        `rollback: failed to restore ${ctx.originalBranch} from ${ctx.backupRef} — ${restore.stderr.trim()}`,
      );
    }
  }

  if (ctx.workRef) {
    const exists = await gitRaw(
      ["rev-parse", "--verify", `refs/heads/${ctx.workRef}`],
      opts,
    );
    if (exists.exitCode === 0) {
      const del = await gitRaw(["branch", "-D", ctx.workRef], opts);
      if (del.exitCode !== 0) {
        log?.warn(
          `rollback: failed to delete work ref ${ctx.workRef} — ${del.stderr.trim()}`,
        );
      }
    }
  }

  ctx.lock?.release();
}

async function currentBranchOrNull(opts: GitOptions): Promise<string | null> {
  const r = await gitRaw(["symbolic-ref", "--short", "HEAD"], opts);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}
