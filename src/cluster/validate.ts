import type { Sha } from "../git/types.js";
import { COMMIT_TYPES, type ClusterInput, type PlanDocument } from "./schema.js";

export type ValidationCode =
  | "EMPTY_CLUSTER"
  | "HALLUCINATED_SHA"
  | "DUPLICATE_MEMBER"
  | "MISSING_MEMBER"
  | "BAD_SUBJECT"
  | "BAD_TYPE"
  | "BAD_DEPENDENCY_ORDER";

export interface ValidationIssue {
  code: ValidationCode;
  clusterId?: string;
  message: string;
}

export interface ValidationContext {
  liveOrMixedShas: Iterable<Sha>;
  droppedShas?: Iterable<Sha>;
  paths?: Map<Sha, { added: string[]; touched: string[] }>;
}

export function validatePlan(
  plan: PlanDocument,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const live = new Set<string>(toStrings(ctx.liveOrMixedShas));
  const droppedExpected = new Set<string>(toStrings(ctx.droppedShas ?? []));

  const seenInClusters = new Map<string, string>();
  for (const c of plan.clusters) {
    if (c.memberShas.length === 0) {
      issues.push({ code: "EMPTY_CLUSTER", clusterId: c.id, message: "cluster has no member shas" });
    }
    for (const m of c.memberShas) {
      if (!isShaInRange(m, live)) {
        issues.push({
          code: "HALLUCINATED_SHA",
          clusterId: c.id,
          message: `sha ${m} not in LIVE/MIXED range commits`,
        });
      }
      const prior = seenInClusters.get(m);
      if (prior) {
        issues.push({
          code: "DUPLICATE_MEMBER",
          clusterId: c.id,
          message: `sha ${m} also in cluster ${prior}`,
        });
      } else {
        seenInClusters.set(m, c.id);
      }
    }
    issues.push(...validateSubject(c));
    if (!COMMIT_TYPES.includes(c.type)) {
      issues.push({ code: "BAD_TYPE", clusterId: c.id, message: `unknown type '${c.type}'` });
    }
  }

  for (const sha of live) {
    const dropped = plan.dropped.some((d) => prefixMatch(d.sha, sha));
    if (!seenInClusters.has(sha) && !dropped && !droppedExpected.has(sha)) {
      issues.push({
        code: "MISSING_MEMBER",
        message: `LIVE/MIXED sha ${sha} is in no cluster and not dropped`,
      });
    }
  }

  if (ctx.paths) {
    issues.push(...validateDependencyOrder(plan, ctx.paths));
  }

  return issues;
}

function validateSubject(c: ClusterInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (c.subject.length === 0) {
    issues.push({ code: "BAD_SUBJECT", clusterId: c.id, message: "subject is empty" });
    return issues;
  }
  if (c.subject.length > 72) {
    issues.push({ code: "BAD_SUBJECT", clusterId: c.id, message: "subject exceeds 72 chars" });
  }
  if (c.subject.endsWith(".")) {
    issues.push({
      code: "BAD_SUBJECT",
      clusterId: c.id,
      message: "subject ends with a period",
    });
  }
  const first = c.subject[0];
  if (first && first !== first.toLowerCase()) {
    issues.push({
      code: "BAD_SUBJECT",
      clusterId: c.id,
      message: "first character of subject must be lowercase (after the type prefix)",
    });
  }
  return issues;
}

function validateDependencyOrder(
  plan: PlanDocument,
  paths: Map<Sha, { added: string[]; touched: string[] }>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const clusterAdded = new Map<string, Set<string>>();
  const clusterTouched = new Map<string, Set<string>>();
  for (const c of plan.clusters) {
    const added = new Set<string>();
    const touched = new Set<string>();
    for (const m of c.memberShas) {
      const p = paths.get(m as Sha);
      if (!p) continue;
      for (const a of p.added) added.add(a);
      for (const t of p.touched) touched.add(t);
    }
    clusterAdded.set(c.id, added);
    clusterTouched.set(c.id, touched);
  }
  for (let i = 0; i < plan.clusters.length; i++) {
    const ci = plan.clusters[i]!;
    const touched = clusterTouched.get(ci.id) ?? new Set();
    for (let j = i + 1; j < plan.clusters.length; j++) {
      const cj = plan.clusters[j]!;
      const added = clusterAdded.get(cj.id) ?? new Set();
      for (const path of touched) {
        if (added.has(path)) {
          issues.push({
            code: "BAD_DEPENDENCY_ORDER",
            clusterId: ci.id,
            message: `cluster ${ci.id} touches '${path}' but it is first added in later cluster ${cj.id}`,
          });
        }
      }
    }
  }
  return issues;
}

function isShaInRange(member: string, range: Set<string>): boolean {
  if (range.has(member)) return true;
  for (const r of range) {
    if (prefixMatch(member, r)) return true;
  }
  return false;
}

function prefixMatch(a: string, b: string): boolean {
  const min = Math.min(a.length, b.length);
  if (min < 7) return false;
  return a.slice(0, min) === b.slice(0, min);
}

function toStrings(it: Iterable<Sha>): string[] {
  return Array.from(it, (s) => String(s));
}
