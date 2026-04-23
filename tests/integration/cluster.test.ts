import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { collectRange } from "../../src/analyze/collect.js";
import { classifyDeadPaths } from "../../src/analyze/dead-paths.js";
import { runApply } from "../../src/apply/run.js";
import { fallbackCluster } from "../../src/cluster/fallback.js";
import { isAtroposError } from "../../src/util/errors.js";
import { createLogger } from "../../src/util/logger.js";
import {
  buildDeadFileFixture,
  buildDeadLinesFixture,
  buildEmptyRangeFixture,
  buildHappyFixture,
  buildMultiAreaFixture,
  buildRenameFixture,
  type FixtureRepo,
} from "../fixtures/build.js";

const cleanups: Array<() => void> = [];
const silent = createLogger({ level: "error", color: false, stream: process.stderr });

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function track(repo: FixtureRepo): FixtureRepo {
  cleanups.push(repo.cleanup);
  return repo;
}

async function rev(cwd: string, ref: string): Promise<string> {
  const r = await execa("git", ["rev-parse", ref], { cwd, reject: false });
  return typeof r.stdout === "string" ? r.stdout.trim() : "";
}

async function classify(repo: FixtureRepo): Promise<Array<{ subject: string; cls: string; live: number; dead: number }>> {
  const collected = await collectRange({ opts: { cwd: repo.dir } });
  const report = await classifyDeadPaths(collected.range, collected.commits, { cwd: repo.dir });
  return collected.commits.map((c) => {
    const r = report.byCommit.get(c.sha)!;
    return { subject: c.subject, cls: r.classification, live: r.liveFiles.length, dead: r.deadFiles.length };
  });
}

describe("dead-path classification", () => {
  it("happy fixture: every commit is LIVE (no dead paths)", async () => {
    const repo = track(await buildHappyFixture());
    const rows = await classify(repo);
    expect(rows.every((r) => r.cls === "LIVE")).toBe(true);
  });

  it("dead-file fixture: scratch.ts add+delete commits are DROP", async () => {
    const repo = track(await buildDeadFileFixture());
    const rows = await classify(repo);
    const labels = rows.map((r) => `${r.cls}:${r.subject}`);
    expect(labels).toEqual([
      "LIVE:feat: add users module",
      "DROP:wip: try scratch helper",
      "DROP:revert: drop scratch helper",
      "LIVE:feat: seed users",
    ]);
  });

  it("dead-lines fixture: file survives, all commits LIVE (hunk problem deferred)", async () => {
    const repo = track(await buildDeadLinesFixture());
    const rows = await classify(repo);
    expect(rows.map((r) => r.cls)).toEqual(["LIVE", "LIVE", "LIVE"]);
  });

  it("rename fixture: rename does not create false dead-paths", async () => {
    const repo = track(await buildRenameFixture());
    const rows = await classify(repo);
    expect(rows.every((r) => r.cls !== "DROP")).toBe(true);
  });
});

describe("heuristic apply preserves T1 (tree equality) and T2 (member coverage)", () => {
  async function applyAndAssertTreeEquality(repo: FixtureRepo): Promise<void> {
    const origTree = await rev(repo.dir, "HEAD^{tree}");
    const origHead = await rev(repo.dir, "HEAD");

    const result = await runApply({ cwd: repo.dir, logger: silent });

    const newTree = await rev(repo.dir, "HEAD^{tree}");
    const backupSha = await rev(repo.dir, result.backupRef);

    expect(newTree).toBe(origTree); // T1
    expect(backupSha).toBe(origHead); // T6
    expect(result.clustersApplied).toBeGreaterThan(0);
  }

  it("dead-file fixture", async () => {
    await applyAndAssertTreeEquality(track(await buildDeadFileFixture()));
  });

  it("dead-lines fixture", async () => {
    await applyAndAssertTreeEquality(track(await buildDeadLinesFixture()));
  });

  it("rename fixture", async () => {
    await applyAndAssertTreeEquality(track(await buildRenameFixture()));
  });

  it("multi-area fixture (no-cloud heuristic over 30-min gap)", async () => {
    const repo = track(await buildMultiAreaFixture());
    const collected = await collectRange({ opts: { cwd: repo.dir } });
    const report = await classifyDeadPaths(collected.range, collected.commits, { cwd: repo.dir });
    const clusters = fallbackCluster({ commits: collected.commits, byClassification: report.byCommit });
    // Expect the 30-min gap to split api/ from tests/ — > 1 cluster
    expect(clusters.length).toBeGreaterThan(1);

    await applyAndAssertTreeEquality(repo);
  });

  it("T2 coverage: every LIVE/MIXED sha appears in exactly one cluster on the happy fixture", async () => {
    const repo = track(await buildHappyFixture());
    const collected = await collectRange({ opts: { cwd: repo.dir } });
    const report = await classifyDeadPaths(collected.range, collected.commits, { cwd: repo.dir });
    const clusters = fallbackCluster({ commits: collected.commits, byClassification: report.byCommit });

    const seen = new Set<string>();
    for (const c of clusters) {
      for (const m of c.memberShas) {
        expect(seen.has(m)).toBe(false);
        seen.add(m);
      }
    }
    const expected = collected.commits
      .filter((c) => report.byCommit.get(c.sha)?.classification !== "DROP")
      .map((c) => String(c.sha));
    expect(seen.size).toBe(expected.length);
    for (const sha of expected) expect(seen.has(sha)).toBe(true);
  });
});

describe("range edge cases", () => {
  it("empty-range fixture: collectRange throws ERR_BAD_RANGE", async () => {
    const repo = track(await buildEmptyRangeFixture());
    let caught: unknown;
    try {
      await collectRange({ rangeSpec: "main..main", opts: { cwd: repo.dir } });
    } catch (err) {
      caught = err;
    }
    expect(isAtroposError(caught)).toBe(true);
    if (isAtroposError(caught)) {
      expect(caught.code).toBe("ERR_BAD_RANGE");
    }
  });
});

describe("heuristic determinism", () => {
  it("two runs of fallbackCluster on the same input produce identical output", async () => {
    const repo = track(await buildMultiAreaFixture());
    const collected = await collectRange({ opts: { cwd: repo.dir } });
    const report = await classifyDeadPaths(collected.range, collected.commits, { cwd: repo.dir });
    const a = fallbackCluster({ commits: collected.commits, byClassification: report.byCommit });
    const b = fallbackCluster({ commits: collected.commits, byClassification: report.byCommit });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
