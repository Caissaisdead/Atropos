import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { collectRange } from "../../src/analyze/collect.js";
import { classifyDeadPaths } from "../../src/analyze/dead-paths.js";
import { runApply } from "../../src/apply/run.js";
import { DEFAULT_STRIP } from "../../src/authorship/patterns.js";
import { fallbackCluster } from "../../src/cluster/fallback.js";
import { createLogger } from "../../src/util/logger.js";
import {
  buildAgentTrailersFixture,
  buildDeadFileFixture,
  buildDeadLinesFixture,
  buildHappyFixture,
  buildHumanPairFixture,
  buildMixedConcernsFixture,
  buildMultiAreaFixture,
  buildRenameFixture,
  type FixtureRepo,
} from "../fixtures/build.js";

const cleanups: Array<() => void> = [];
const silent = createLogger({ level: "error", color: false, stream: process.stderr });
const TARGET = { name: "Sid Nigam", email: "sid@example.com" };

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

interface FixtureCase {
  name: string;
  build: () => Promise<FixtureRepo>;
  /** Source has at least one expected stripped pattern (T4 has signal). */
  hasAgentAttribution?: boolean;
  /** Source has at least one preservable trailer that should survive (T5 has signal). */
  hasHumanTrailers?: boolean;
}

const FIXTURES: FixtureCase[] = [
  { name: "happy", build: buildHappyFixture },
  { name: "dead-file", build: buildDeadFileFixture },
  { name: "dead-lines", build: buildDeadLinesFixture },
  { name: "rename", build: buildRenameFixture },
  { name: "multi-area", build: buildMultiAreaFixture },
  { name: "mixed-concerns", build: buildMixedConcernsFixture },
  { name: "agent-trailers", build: buildAgentTrailersFixture, hasAgentAttribution: true },
  { name: "human-pair", build: buildHumanPairFixture, hasHumanTrailers: true },
];

async function rev(cwd: string, ref: string): Promise<string> {
  const r = await execa("git", ["rev-parse", ref], { cwd, reject: false });
  return typeof r.stdout === "string" ? r.stdout.trim() : "";
}

async function readNewCommitBodies(cwd: string, branch: string): Promise<string[]> {
  const SEP = "@@INV@@";
  const out = await execa(
    "git",
    ["log", "--reverse", "--no-merges", `--format=%aN%n%aE%n%B${SEP}`, `main..${branch}`],
    { cwd, reject: false },
  );
  const stdout = typeof out.stdout === "string" ? out.stdout : "";
  return stdout.split(SEP).map((s) => s.trim()).filter(Boolean);
}

function bodyMatchesAnyStrip(body: string): boolean {
  for (const re of DEFAULT_STRIP.trailerPatterns) if (re.test(body)) return true;
  for (const re of DEFAULT_STRIP.footerLinePatterns) if (re.test(body)) return true;
  return false;
}

describe("T1-T7 invariants across all fixtures", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}`, async () => {
      const repo = await fixture.build();
      cleanups.push(repo.cleanup);

      // Compute T2 expectations *before* apply (clusters from heuristic)
      const collected = await collectRange({ opts: { cwd: repo.dir } });
      const dead = await classifyDeadPaths(collected.range, collected.commits, { cwd: repo.dir });
      const clustersPreApply = fallbackCluster({
        commits: collected.commits,
        byClassification: dead.byCommit,
      });
      const expectedNonDrop = new Set(
        collected.commits
          .filter((c) => dead.byCommit.get(c.sha)?.classification !== "DROP")
          .map((c) => String(c.sha)),
      );
      const seenInClusters = new Set<string>();
      for (const c of clustersPreApply) {
        for (const m of c.memberShas) {
          // T2: no member should appear in two clusters
          expect(seenInClusters.has(m)).toBe(false);
          seenInClusters.add(m);
        }
      }
      // T2: every non-DROP sha is covered
      for (const sha of expectedNonDrop) expect(seenInClusters.has(sha)).toBe(true);

      const origHead = await rev(repo.dir, "HEAD");
      const origTree = await rev(repo.dir, "HEAD^{tree}");

      const result = await runApply({
        cwd: repo.dir,
        targetAuthor: TARGET,
        logger: silent,
      });

      // T1: tree equality
      const newTree = await rev(repo.dir, "HEAD^{tree}");
      expect(newTree).toBe(origTree);

      // T6: backup ref points at pre-apply head
      const backupSha = await rev(repo.dir, result.backupRef);
      expect(backupSha).toBe(origHead);

      // T7: no lock left
      expect(existsSync(join(repo.dir, ".git/atropos.lock"))).toBe(false);

      // T3, T4, T5
      const bodies = await readNewCommitBodies(repo.dir, repo.branch);
      expect(bodies.length).toBeGreaterThan(0);
      for (const entry of bodies) {
        const lines = entry.split("\n");
        const [authorName = "", authorEmail = ""] = lines;
        const body = lines.slice(2).join("\n");
        // T3
        expect(authorName).toBe(TARGET.name);
        expect(authorEmail).toBe(TARGET.email);
        // T4 — only meaningful if source had agent attribution
        if (fixture.hasAgentAttribution) {
          expect(bodyMatchesAnyStrip(body)).toBe(false);
        }
      }

      if (fixture.hasHumanTrailers) {
        const allBodies = bodies.join("\n");
        // T5: at least one preserved trailer survives
        expect(allBodies).toMatch(/Co-authored-by: Priya Patel/);
        expect(allBodies).toMatch(/Signed-off-by: Sid Nigam/);
      }
    });
  }
});
