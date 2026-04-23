import { listMergeShasInRange, listShasInRange, readCommits } from "../git/commits.js";
import {
  currentBranch,
  defaultBaseRef,
  revParse,
  tryMergeBase,
  tryRevParse,
  upstreamOf,
} from "../git/refs.js";
import type { GitOptions } from "../git/shell.js";
import type { Commit, Range, Sha } from "../git/types.js";
import { AtroposError } from "../util/errors.js";

export interface CollectInput {
  rangeSpec?: string;
  opts?: GitOptions;
}

export interface CollectResult {
  range: Range;
  commits: Commit[];
  mergeBase: Sha;
  mergeCount: number;
}

export async function resolveRange(input: CollectInput): Promise<Range> {
  const opts = input.opts ?? {};
  const headRef = await currentBranch(opts);

  let baseRef: string;
  if (input.rangeSpec) {
    const parts = input.rangeSpec.split("..");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new AtroposError({
        code: "ERR_BAD_RANGE",
        what: `range '${input.rangeSpec}' is not in <base>..<head> form`,
        fix: "use a range like `main..HEAD`",
      });
    }
    baseRef = parts[0];
    const explicitHead = parts[1];
    const head = await revParse(explicitHead, opts);
    const base = await revParse(baseRef, opts);
    return { base, head, baseRef, headRef: explicitHead };
  }

  const upstream = await upstreamOf(headRef, opts);
  if (upstream) {
    baseRef = upstream;
  } else {
    const fallback = await defaultBaseRef(opts);
    if (!fallback) {
      throw new AtroposError({
        code: "ERR_BAD_RANGE",
        what: "no base ref could be determined",
        why: "no @{upstream} for HEAD and none of main/master/develop exist",
        fix: "pass an explicit range like `atropos main..HEAD`",
      });
    }
    if (fallback === headRef) {
      throw new AtroposError({
        code: "ERR_BAD_RANGE",
        what: `default base '${fallback}' is the current branch`,
        fix: "pass an explicit range like `atropos main..HEAD`",
      });
    }
    baseRef = fallback;
  }

  const baseSha = await revParse(baseRef, opts);
  const headSha = await revParse(headRef, opts);
  return { base: baseSha, head: headSha, baseRef, headRef };
}

export async function collectRange(input: CollectInput = {}): Promise<CollectResult> {
  const opts = input.opts ?? {};
  const range = await resolveRange(input);
  // Orphan branches (no common ancestor) are legitimate; fall back to the
  // explicit base as the boundary so `<base>..<head>` still gives the
  // expected commit set.
  const maybeMb = await tryMergeBase(range.base, range.head, opts);
  const mb = maybeMb ?? range.base;

  const shas = await listShasInRange(mb, range.head, opts);
  const merges = await listMergeShasInRange(mb, range.head, opts);
  const commits = await readCommits(shas, opts);

  if (commits.length === 0) {
    throw new AtroposError({
      code: "ERR_BAD_RANGE",
      what: `range ${range.baseRef}..${range.headRef} contains no commits`,
      fix: "make a commit, or pass a range with content",
    });
  }

  return { range, commits, mergeBase: mb, mergeCount: merges.length };
}

export async function existsRef(ref: string, opts: GitOptions = {}): Promise<boolean> {
  return (await tryRevParse(ref, opts)) !== null;
}
