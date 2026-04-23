import { longestCommonDir, topDir } from "../analyze/net-diff.js";
import type { CommitClassification } from "../analyze/dead-paths.js";
import type { Commit, FileChange, Sha } from "../git/types.js";
import { COMMIT_TYPES, type ClusterInput, type CommitType } from "./schema.js";

const GAP_LIMIT_MS = 30 * 60 * 1000;
const OVERLAP_THRESHOLD = 0.5;
const HEURISTIC_REASONING = "heuristic fallback (no LLM)";

export interface FallbackInput {
  commits: readonly Commit[];
  byClassification: Map<Sha, CommitClassification>;
}

interface BuildingCluster {
  members: Commit[];
  topDirs: Set<string>;
  fingerprint: string;
  files: Set<string>;
  liveFiles: Set<string>;
  lastAuthoredAtMs: number;
}

export function fallbackCluster(input: FallbackInput): ClusterInput[] {
  // Preserve topological input order (collectRange returns `git rev-list --reverse`),
  // breaking authoredAt-ties by original index — sha-tiebreak would scramble
  // same-second commits relative to their parent/child relationship.
  const indexed = input.commits.map((c, i) => ({ c, i }));
  const eligible = indexed
    .filter(({ c }) => input.byClassification.get(c.sha)?.classification !== "DROP")
    .sort((a, b) => {
      const cmp = a.c.authoredAt.localeCompare(b.c.authoredAt);
      return cmp !== 0 ? cmp : a.i - b.i;
    })
    .map(({ c }) => c);

  const clusters: BuildingCluster[] = [];
  for (const c of eligible) {
    const liveFiles = liveFilesOf(c, input.byClassification);
    const tDirs = new Set(filePaths(c).map(topDir));
    const fp = fingerprint(tDirs);
    const fileSet = new Set(filePaths(c));
    const ts = parseTimestamp(c.authoredAt);

    const current = clusters[clusters.length - 1];
    const merge =
      current !== undefined &&
      shouldMerge(current, { fingerprint: fp, files: fileSet, ts });

    if (current && merge) {
      current.members.push(c);
      for (const d of tDirs) current.topDirs.add(d);
      for (const f of fileSet) current.files.add(f);
      for (const lf of liveFiles) current.liveFiles.add(lf);
      current.lastAuthoredAtMs = Math.max(current.lastAuthoredAtMs, ts);
    } else {
      clusters.push({
        members: [c],
        topDirs: tDirs,
        fingerprint: fp,
        files: fileSet,
        liveFiles: new Set(liveFiles),
        lastAuthoredAtMs: ts,
      });
    }
  }

  return clusters.map((b, i) => buildClusterInput(b, i));
}

function shouldMerge(
  current: BuildingCluster,
  next: { fingerprint: string; files: Set<string>; ts: number },
): boolean {
  if (current.fingerprint === next.fingerprint) return true;
  if (next.ts - current.lastAuthoredAtMs >= GAP_LIMIT_MS) return false;
  const overlap = intersectionSize(current.files, next.files);
  const denom = Math.min(current.files.size, next.files.size);
  if (denom === 0) return false;
  return overlap / denom >= OVERLAP_THRESHOLD;
}

function buildClusterInput(b: BuildingCluster, idx: number): ClusterInput {
  const liveFiles = Array.from(b.liveFiles).sort();
  const allChanges = b.members.flatMap((m) => m.files);
  const verb = computeVerb(allChanges, b.liveFiles);
  const type = pickType(b.members);
  const scope = pickScope(liveFiles);
  const subject = composeSubject(verb, liveFiles);

  const cluster: ClusterInput = {
    id: `c${idx + 1}`,
    type,
    subject,
    memberShas: b.members.map((m) => String(m.sha)),
    reasoning: HEURISTIC_REASONING,
    confidence: 0.4,
  };
  if (scope) cluster.scope = scope;
  return cluster;
}

function pickType(members: readonly Commit[]): CommitType {
  const counts = new Map<CommitType, number>();
  for (const m of members) {
    const t = parseTypeFromSubject(m.subject);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: CommitType = "chore";
  let bestN = -1;
  for (const t of COMMIT_TYPES) {
    const n = counts.get(t) ?? 0;
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  return best;
}

function parseTypeFromSubject(subject: string): CommitType | null {
  const m = /^([a-z]+)(?:\([^)]+\))?[:!]/.exec(subject);
  if (!m) return null;
  const t = m[1] as CommitType;
  return COMMIT_TYPES.includes(t) ? t : null;
}

function pickScope(files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  const dir = longestCommonDir(files);
  if (!dir) return undefined;
  const parts = dir.split("/");
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : dir;
}

function composeSubject(verb: string, files: readonly string[]): string {
  if (files.length === 0) return `${verb} unspecified`;
  const dirs = uniqueSorted(files.map(topDir));
  const joined = dirs.length === 1 ? (dirs[0] === "." ? files[0]! : dirs[0]!) : dirs.slice(0, 3).join(", ");
  const rough = `${verb} ${joined}`;
  return truncateSubject(rough, 72);
}

function truncateSubject(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function computeVerb(changes: readonly FileChange[], liveFiles: ReadonlySet<string>): string {
  let onlyAdd = true;
  let onlyDelete = true;
  for (const f of changes) {
    if (!liveFiles.has(f.path)) continue;
    if (f.status !== "A") onlyAdd = false;
    if (f.status !== "D") onlyDelete = false;
  }
  if (onlyAdd) return "add";
  if (onlyDelete) return "remove";
  return "update";
}

function liveFilesOf(c: Commit, byClassification: Map<Sha, CommitClassification>): string[] {
  const cls = byClassification.get(c.sha);
  return cls ? cls.liveFiles : c.files.map((f) => f.path);
}

function filePaths(c: Commit): string[] {
  const out: string[] = [];
  for (const f of c.files) out.push(f.path);
  return out;
}

function fingerprint(topDirs: ReadonlySet<string>): string {
  return Array.from(topDirs).sort().join("|");
}

function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function parseTimestamp(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function uniqueSorted(arr: readonly string[]): string[] {
  return Array.from(new Set(arr)).sort();
}
