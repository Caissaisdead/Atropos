import { AtroposError } from "../util/errors.js";
import { git, gitRaw, type GitOptions } from "./shell.js";
import { asSha, type Sha } from "./types.js";

export async function revParse(ref: string, opts: GitOptions = {}): Promise<Sha> {
  const out = await git(["rev-parse", "--verify", ref], opts);
  return asSha(out.trim());
}

export async function tryRevParse(ref: string, opts: GitOptions = {}): Promise<Sha | null> {
  const r = await gitRaw(["rev-parse", "--verify", ref], opts);
  return r.exitCode === 0 ? asSha(r.stdout.trim()) : null;
}

export async function mergeBase(a: string, b: string, opts: GitOptions = {}): Promise<Sha> {
  const out = await git(["merge-base", a, b], opts);
  return asSha(out.trim());
}

export async function tryMergeBase(
  a: string,
  b: string,
  opts: GitOptions = {},
): Promise<Sha | null> {
  // `git merge-base` exits 1 (and prints nothing) when the two commits share
  // no common ancestor — a legitimate result for orphan branches, not an error.
  const r = await gitRaw(["merge-base", a, b], opts);
  if (r.exitCode !== 0) return null;
  const out = r.stdout.trim();
  return out ? asSha(out) : null;
}

export async function currentBranch(opts: GitOptions = {}): Promise<string> {
  const r = await gitRaw(["symbolic-ref", "--short", "HEAD"], opts);
  if (r.exitCode !== 0) {
    throw new AtroposError({
      code: "ERR_BAD_RANGE",
      what: "HEAD is detached",
      fix: "check out a branch before running atropos",
    });
  }
  return r.stdout.trim();
}

export async function upstreamOf(ref: string, opts: GitOptions = {}): Promise<string | null> {
  const r = await gitRaw(["rev-parse", "--abbrev-ref", `${ref}@{upstream}`], opts);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function listRemotes(opts: GitOptions = {}): Promise<string[]> {
  const out = await git(["remote"], opts);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export interface RemoteRef {
  ref: string;
  sha: Sha;
}

export async function listRemoteTrackingRefs(
  remote?: string,
  opts: GitOptions = {},
): Promise<RemoteRef[]> {
  const path = remote ? `refs/remotes/${remote}` : "refs/remotes";
  const out = await git(["for-each-ref", "--format=%(objectname) %(refname)", path], opts);
  if (!out.trim()) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(" ");
      const sha = line.slice(0, idx);
      const ref = line.slice(idx + 1);
      return { sha: asSha(sha), ref };
    })
    .filter((r) => !r.ref.endsWith("/HEAD"));
}

export async function defaultBaseRef(opts: GitOptions = {}): Promise<string | null> {
  const candidates = ["main", "master", "develop"];
  for (const c of candidates) {
    if (await tryRevParse(c, opts)) return c;
  }
  const r = await gitRaw(["symbolic-ref", "refs/remotes/origin/HEAD"], opts);
  if (r.exitCode === 0) {
    const ref = r.stdout.trim().replace(/^refs\/remotes\//, "");
    return ref || null;
  }
  return null;
}

export async function isAncestor(
  ancestor: string,
  descendant: string,
  opts: GitOptions = {},
): Promise<boolean> {
  const r = await gitRaw(["merge-base", "--is-ancestor", ancestor, descendant], opts);
  return r.exitCode === 0;
}
