import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { runApply } from "../../src/apply/run.js";
import { createLogger } from "../../src/util/logger.js";
import {
  buildAgentTrailersFixture,
  buildHumanPairFixture,
  type FixtureRepo,
} from "../fixtures/build.js";

const cleanups: Array<() => void> = [];
const silent = createLogger({ level: "error", color: false, stream: process.stderr });
const TARGET = { name: "Sid Nigam", email: "sid@example.com" };

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function track(repo: FixtureRepo): FixtureRepo {
  cleanups.push(repo.cleanup);
  return repo;
}

interface GitCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  body: string;
}

async function readNewCommits(repo: FixtureRepo): Promise<GitCommit[]> {
  const SEP = "@@ATROPOS_TEST@@";
  const fmt = `%H%n%aN%n%aE%n%B${SEP}`;
  const out = await execa(
    "git",
    ["log", "--reverse", "--no-merges", `--format=${fmt}`, "main..HEAD"],
    { cwd: repo.dir, reject: false },
  );
  const stdout = typeof out.stdout === "string" ? out.stdout : "";
  return stdout
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const lines = entry.split("\n");
      const [sha = "", authorName = "", authorEmail = "", ...rest] = lines;
      return { sha, authorName, authorEmail, body: rest.join("\n").trim() };
    });
}

describe("authorship normalization", () => {
  it("agent-trailers: T3 author normalized, T4 no Claude trailers / footers in output", async () => {
    const repo = track(await buildAgentTrailersFixture());
    await runApply({ cwd: repo.dir, targetAuthor: TARGET, logger: silent });

    const commits = await readNewCommits(repo);
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) {
      // T3
      expect(c.authorName).toBe(TARGET.name);
      expect(c.authorEmail).toBe(TARGET.email);
      // T4
      expect(c.body.toLowerCase()).not.toContain("co-authored-by: claude");
      expect(c.body).not.toContain("noreply@anthropic.com");
      expect(c.body).not.toContain("🤖 Generated with");
      expect(c.body).not.toContain("claude.ai/code");
    }
  });

  it("human-pair: T5 preserved trailers survive, zero false positives on Co-authored-by: Priya", async () => {
    const repo = track(await buildHumanPairFixture());
    await runApply({ cwd: repo.dir, targetAuthor: TARGET, logger: silent });

    const commits = await readNewCommits(repo);
    const allBodies = commits.map((c) => c.body).join("\n");

    // T5: preserved trailers from at least one source commit are present in output
    expect(allBodies).toContain("Co-authored-by: Priya Patel <priya@example.com>");
    expect(allBodies).toContain("Signed-off-by: Sid Nigam <sid@example.com>");
    expect(allBodies).toContain("Closes: #42");

    // T3: target author applied
    for (const c of commits) {
      expect(c.authorEmail).toBe(TARGET.email);
    }
  });

  it("--preserve-agent-attribution keeps Claude trailers", async () => {
    const repo = track(await buildAgentTrailersFixture());
    await runApply({
      cwd: repo.dir,
      targetAuthor: TARGET,
      preserveAgentAttribution: true,
      logger: silent,
    });

    const commits = await readNewCommits(repo);
    const all = commits.map((c) => c.body).join("\n");
    expect(all.toLowerCase()).toContain("co-authored-by: claude");
  });

  it("Co-authored-by deduplicated across cluster members (Priya appears once per cluster)", async () => {
    const repo = track(await buildHumanPairFixture());
    await runApply({ cwd: repo.dir, targetAuthor: TARGET, logger: silent });

    const commits = await readNewCommits(repo);
    for (const c of commits) {
      const matches = c.body.match(/Co-authored-by: Priya Patel/g) ?? [];
      expect(matches.length).toBeLessThanOrEqual(1);
    }
  });
});
