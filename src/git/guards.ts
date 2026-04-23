import { existsSync } from "node:fs";
import { join } from "node:path";
import { AtroposError } from "../util/errors.js";
import { git, gitRaw, type GitOptions } from "./shell.js";

export async function gitDir(opts: GitOptions = {}): Promise<string> {
  const out = await git(["rev-parse", "--git-dir"], opts);
  return out.trim();
}

export async function gitTopLevel(opts: GitOptions = {}): Promise<string> {
  const out = await git(["rev-parse", "--show-toplevel"], opts);
  return out.trim();
}

export async function assertInRepo(opts: GitOptions = {}): Promise<void> {
  const r = await gitRaw(["rev-parse", "--git-dir"], opts);
  if (r.exitCode !== 0) {
    throw new AtroposError({
      code: "ERR_NOT_A_REPO",
      what: "not a git repository",
      fix: "run atropos inside a repo",
    });
  }
}

export async function assertCleanTree(opts: GitOptions = {}): Promise<void> {
  const out = await git(["status", "--porcelain"], opts);
  if (out.trim().length > 0) {
    throw new AtroposError({
      code: "ERR_DIRTY",
      what: "working tree has uncommitted changes",
      fix: "commit, stash, or pass `--allow-dirty`",
    });
  }
}

export async function assertNoMergeOrRebase(opts: GitOptions = {}): Promise<void> {
  const dir = await gitDir(opts);
  const cwd = opts.cwd ?? process.cwd();
  const fullDir = dir.startsWith("/") ? dir : join(cwd, dir);
  const indicators = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ];
  for (const ind of indicators) {
    if (existsSync(join(fullDir, ind))) {
      throw new AtroposError({
        code: "ERR_DIRTY",
        what: `git is in the middle of a ${ind.toLowerCase().replace(/_head|-/g, " ").trim()} operation`,
        fix: "finish or abort the in-progress operation before running atropos",
      });
    }
  }
}

export async function assertSupportedRepoLayout(opts: GitOptions = {}): Promise<void> {
  const dir = await gitDir(opts);
  const cwd = opts.cwd ?? process.cwd();
  const fullDir = dir.startsWith("/") ? dir : join(cwd, dir);

  const subOut = await gitRaw(["submodule", "status"], opts);
  if (subOut.exitCode === 0 && subOut.stdout.trim().length > 0) {
    throw new AtroposError({
      code: "ERR_UNSUPPORTED",
      what: "submodules detected",
      why: "atropos v1 does not support repos with submodules",
    });
  }

  const wtOut = await gitRaw(["worktree", "list", "--porcelain"], opts);
  if (wtOut.exitCode === 0) {
    const lines = wtOut.stdout.split("\n").filter((l) => l.startsWith("worktree "));
    if (lines.length > 1) {
      throw new AtroposError({
        code: "ERR_UNSUPPORTED",
        what: "additional git worktrees detected",
        why: "atropos v1 only operates on the primary worktree",
      });
    }
  }

  if (existsSync(join(fullDir, "lfs"))) {
    throw new AtroposError({
      code: "ERR_UNSUPPORTED",
      what: "Git LFS detected",
      why: "atropos v1 does not support LFS repos",
    });
  }
}
