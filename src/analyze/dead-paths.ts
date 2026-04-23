import { lsTree } from "../git/commits.js";
import type { GitOptions } from "../git/shell.js";
import type { Commit, Range, Sha } from "../git/types.js";

export type CommitClass = "DROP" | "MIXED" | "LIVE";

export interface DeadPathReport {
  baseTree: Set<string>;
  headTree: Set<string>;
  deadFiles: Set<string>;
  byCommit: Map<Sha, CommitClassification>;
}

export interface CommitClassification {
  sha: Sha;
  classification: CommitClass;
  liveFiles: string[];
  deadFiles: string[];
}

export async function classifyDeadPaths(
  range: Range,
  commits: readonly Commit[],
  opts: GitOptions = {},
): Promise<DeadPathReport> {
  const baseTree = await lsTree(range.base, opts);
  const headTree = await lsTree(range.head, opts);

  const touched = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) {
      touched.add(f.path);
      if (f.oldPath) touched.add(f.oldPath);
    }
  }

  const deadFiles = new Set<string>();
  for (const p of touched) {
    if (!baseTree.has(p) && !headTree.has(p)) {
      deadFiles.add(p);
    }
  }

  const byCommit = new Map<Sha, CommitClassification>();
  for (const c of commits) {
    const live: string[] = [];
    const dead: string[] = [];
    const seen = new Set<string>();
    for (const f of c.files) {
      const path = f.path;
      if (seen.has(path)) continue;
      seen.add(path);
      if (deadFiles.has(path)) dead.push(path);
      else live.push(path);
    }
    let classification: CommitClass;
    if (live.length === 0 && dead.length > 0) classification = "DROP";
    else if (dead.length > 0) classification = "MIXED";
    else classification = "LIVE";
    byCommit.set(c.sha, { sha: c.sha, classification, liveFiles: live, deadFiles: dead });
  }

  return { baseTree, headTree, deadFiles, byCommit };
}

export function liveOrMixed(report: DeadPathReport): Sha[] {
  const out: Sha[] = [];
  for (const [sha, c] of report.byCommit) {
    if (c.classification !== "DROP") out.push(sha);
  }
  return out;
}

export function dropped(report: DeadPathReport): Sha[] {
  const out: Sha[] = [];
  for (const [sha, c] of report.byCommit) {
    if (c.classification === "DROP") out.push(sha);
  }
  return out;
}
