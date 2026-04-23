import type { Identity, Trailer } from "../git/types.js";
import {
  DEFAULT_PRESERVE_TRAILER_KEYS,
  DEFAULT_STRIP,
  isPreservedTrailerKey,
  type StripPatterns,
} from "./patterns.js";

export interface StripOptions {
  patterns?: StripPatterns;
  preserveTrailerKeys?: readonly string[];
}

export interface StripStat {
  pattern: string;
  count: number;
}

export interface CleanedMessage {
  subject: string;
  body: string;
  preservedTrailers: Trailer[];
  strippedTrailers: Trailer[];
  strippedFooterLines: string[];
  stripStats: StripStat[];
  preserveStats: Array<{ key: string; count: number }>;
}

export interface CleanedAuthorship {
  message: CleanedMessage;
  authorReplaced: boolean;
  committerReplaced: boolean;
}

export function cleanMessage(
  raw: { subject: string; body: string; trailers: readonly Trailer[] },
  opts: StripOptions = {},
): CleanedMessage {
  const patterns = opts.patterns ?? DEFAULT_STRIP;
  const preserveKeys = opts.preserveTrailerKeys ?? DEFAULT_PRESERVE_TRAILER_KEYS;

  const stripCounts = new Map<string, number>();
  const preserveCounts = new Map<string, number>();
  const recordStrip = (pattern: string): void => {
    stripCounts.set(pattern, (stripCounts.get(pattern) ?? 0) + 1);
  };
  const recordPreserve = (key: string): void => {
    preserveCounts.set(key, (preserveCounts.get(key) ?? 0) + 1);
  };

  const preservedTrailers: Trailer[] = [];
  const strippedTrailers: Trailer[] = [];

  for (const t of raw.trailers) {
    let stripped = false;
    for (const re of patterns.trailerPatterns) {
      if (re.test(t.raw)) {
        strippedTrailers.push(t);
        recordStrip(re.source);
        stripped = true;
        break;
      }
    }
    if (stripped) continue;

    if (isPreservedTrailerKey(t.key, preserveKeys) || /^Co-authored-by$/i.test(t.key)) {
      preservedTrailers.push(t);
      recordPreserve(t.key);
    } else {
      preservedTrailers.push(t);
      recordPreserve(t.key);
    }
  }

  const strippedFooterLines: string[] = [];
  const cleanedBody = stripFooterLines(raw.body, patterns, recordStrip, strippedFooterLines);
  const cleanedSubject = stripSubject(raw.subject, patterns, recordStrip);

  return {
    subject: cleanedSubject,
    body: cleanedBody,
    preservedTrailers,
    strippedTrailers,
    strippedFooterLines,
    stripStats: Array.from(stripCounts, ([pattern, count]) => ({ pattern, count })),
    preserveStats: Array.from(preserveCounts, ([key, count]) => ({ key, count })),
  };
}

function stripFooterLines(
  body: string,
  patterns: StripPatterns,
  recordStrip: (pattern: string) => void,
  strippedOut: string[],
): string {
  if (!body) return "";
  const lines = body.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    let stripped = false;
    for (const re of patterns.footerLinePatterns) {
      if (re.test(line)) {
        recordStrip(re.source);
        strippedOut.push(line);
        stripped = true;
        break;
      }
    }
    if (!stripped) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripSubject(
  subject: string,
  patterns: StripPatterns,
  recordStrip: (pattern: string) => void,
): string {
  let s = subject;
  for (const re of patterns.footerLinePatterns) {
    if (re.test(s)) {
      recordStrip(re.source);
      s = s.replace(re, "").trim();
    }
  }
  return s;
}

export function isBotIdentity(id: Identity, patterns: StripPatterns = DEFAULT_STRIP): boolean {
  return patterns.botEmailPatterns.some((re) => re.test(id.email));
}
