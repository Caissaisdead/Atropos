import type { Commit, Trailer } from "../git/types.js";
import { cleanMessage, type CleanedMessage, type StripOptions } from "./strip.js";

export interface ClusterAuthorshipReport {
  perMember: Array<{ sha: string; cleaned: CleanedMessage }>;
  preservedTrailers: Trailer[];
  strippedTrailers: Trailer[];
  strippedFooterLines: string[];
  stripStats: Array<{ pattern: string; count: number }>;
  preserveStats: Array<{ key: string; count: number }>;
}

export function reportClusterAuthorship(
  members: readonly Commit[],
  opts: StripOptions = {},
): ClusterAuthorshipReport {
  const perMember = members.map((m) => ({
    sha: String(m.sha),
    cleaned: cleanMessage({ subject: m.subject, body: m.body, trailers: m.trailers }, opts),
  }));

  const preservedSeen = new Set<string>();
  const preserved: Trailer[] = [];
  const stripStatTotals = new Map<string, number>();
  const preserveStatTotals = new Map<string, number>();
  const strippedTrailers: Trailer[] = [];
  const strippedFooterLines: string[] = [];

  for (const { cleaned } of perMember) {
    for (const t of cleaned.preservedTrailers) {
      const dedup = `${t.key}:${t.value}`.toLowerCase();
      if (preservedSeen.has(dedup)) continue;
      preservedSeen.add(dedup);
      preserved.push(t);
    }
    for (const t of cleaned.strippedTrailers) strippedTrailers.push(t);
    for (const fl of cleaned.strippedFooterLines) strippedFooterLines.push(fl);
    for (const s of cleaned.stripStats) {
      stripStatTotals.set(s.pattern, (stripStatTotals.get(s.pattern) ?? 0) + s.count);
    }
    for (const p of cleaned.preserveStats) {
      preserveStatTotals.set(p.key, (preserveStatTotals.get(p.key) ?? 0) + p.count);
    }
  }

  return {
    perMember,
    preservedTrailers: preserved,
    strippedTrailers,
    strippedFooterLines,
    stripStats: Array.from(stripStatTotals, ([pattern, count]) => ({ pattern, count })),
    preserveStats: Array.from(preserveStatTotals, ([key, count]) => ({ key, count })),
  };
}
