import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { runApply } from "../../src/apply/run.js";
import { createLogger } from "../../src/util/logger.js";
import { buildHappyFixture, type FixtureRepo } from "../fixtures/build.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function track(repo: FixtureRepo): FixtureRepo {
  cleanups.push(repo.cleanup);
  return repo;
}

describe("apply --dry-run", () => {
  it("prints git commands and does not mutate the repo", async () => {
    const repo = track(await buildHappyFixture());
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      color: false,
      stream: { write: (chunk: string) => { lines.push(chunk); return true; } } as never,
    });

    const head0 = await execa("git", ["rev-parse", "HEAD"], { cwd: repo.dir });
    const refsOut0 = await execa(
      "git",
      ["for-each-ref", "refs/heads/atropos/*"],
      { cwd: repo.dir, reject: false },
    );

    await runApply({ cwd: repo.dir, dryRun: true, logger });

    const out = lines.join("");
    expect(out).toContain("# atropos dry-run");
    expect(out).toContain("git checkout -b atropos/work-");
    expect(out).toContain("git cherry-pick -n --allow-empty --keep-redundant-commits");
    expect(out).toContain("GIT_AUTHOR_NAME=\"<configured author>\"");
    expect(out).toContain("test \"$(git rev-parse atropos/work-");
    expect(out).toContain("git branch -f feature/invoices atropos/work-");
    expect(out).toContain("git push --force-with-lease");

    // No mutations: HEAD unchanged, no atropos/* branches, no lock
    const head1 = await execa("git", ["rev-parse", "HEAD"], { cwd: repo.dir });
    expect(head1.stdout).toBe(head0.stdout);
    const refsOut1 = await execa(
      "git",
      ["for-each-ref", "refs/heads/atropos/*"],
      { cwd: repo.dir, reject: false },
    );
    expect(refsOut1.stdout).toBe(refsOut0.stdout);
    expect(existsSync(join(repo.dir, ".git/atropos.lock"))).toBe(false);
  });
});
