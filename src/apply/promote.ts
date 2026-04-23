import { git, gitRaw, type GitOptions } from "../git/shell.js";
import { AtroposError } from "../util/errors.js";

export async function promote(
  originalBranch: string,
  workRef: string,
  opts: GitOptions = {},
): Promise<void> {
  const force = await gitRaw(["branch", "-f", originalBranch, workRef], opts);
  if (force.exitCode !== 0) {
    throw new AtroposError({
      code: "ERR_UNKNOWN",
      what: `failed to move branch ${originalBranch} → ${workRef}`,
      why: force.stderr,
      fix: "atropos restore returns to the backup; investigate the git error first",
    });
  }

  await git(["checkout", "-q", originalBranch], opts);

  const del = await gitRaw(["branch", "-D", workRef], opts);
  if (del.exitCode !== 0) {
    // not fatal — work ref may already be gone; surface as warning via stderr only.
  }
}
