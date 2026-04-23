import { findLatestBackup } from "../apply/backup.js";
import { gitRaw, type GitOptions } from "../git/shell.js";
import { assertCleanTree, assertInRepo } from "../git/guards.js";
import { currentBranch, revParse } from "../git/refs.js";
import { AtroposError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";

export interface RestoreCliOptions {
  force?: boolean;
  logger: Logger;
}

export async function restoreCommand(opts: RestoreCliOptions): Promise<number> {
  const gitOpts: GitOptions = {};
  await assertInRepo(gitOpts);
  if (!opts.force) await assertCleanTree(gitOpts);

  const latest = await findLatestBackup(gitOpts);
  if (!latest) {
    throw new AtroposError({
      code: "ERR_BAD_RANGE",
      what: "no atropos backup branches found",
      why: "no refs matching refs/heads/atropos/backup-*",
      fix: "there is nothing to restore",
    });
  }

  const branch = await currentBranch(gitOpts);
  const currentSha = await revParse(branch, gitOpts);
  const backupSha = await revParse(latest, gitOpts);

  if (currentSha === backupSha) {
    opts.logger.info(`current branch ${branch} already matches ${latest}; nothing to do`);
    return 0;
  }

  const reset = await gitRaw(["reset", "--hard", latest], gitOpts);
  if (reset.exitCode !== 0) {
    throw new AtroposError({
      code: "ERR_UNKNOWN",
      what: `failed to reset ${branch} to ${latest}`,
      why: reset.stderr.trim(),
      fix: "run `git status` to see what's blocking the reset; pass `--force` if you want to drop local changes",
    });
  }
  opts.logger.info(`restored ${branch} to ${latest}`);
  opts.logger.info(`previous tip: ${currentSha.slice(0, 8)}`);
  return 0;
}
