import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { applyCommand } from "../../src/cli/apply.js";
import { reshapeCommand } from "../../src/cli/reshape.js";
import { isAtroposError } from "../../src/util/errors.js";
import { createLogger } from "../../src/util/logger.js";
import {
  buildAgentTrailersFixture,
  buildHappyFixture,
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

const ORIG_CWD = process.cwd();
function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  process.chdir(dir);
  return fn().finally(() => process.chdir(ORIG_CWD));
}

describe("reshape → file → apply", () => {
  it("happy fixture: reshape writes plan, apply consumes plan, T1 holds", async () => {
    const repo = track(await buildHappyFixture());
    const origTree = await rev(repo.dir, "HEAD^{tree}");
    const planPath = join(repo.dir, ".atropos/plan.md");

    await withCwd(repo.dir, async () => {
      await reshapeCommand({ logger: silent });
    });
    expect(existsSync(planPath)).toBe(true);
    const planSrc = readFileSync(planPath, "utf8");
    expect(planSrc).toContain("<!-- atropos:begin -->");
    expect(planSrc).toContain("```yaml");

    await withCwd(repo.dir, async () => {
      await applyCommand({ logger: silent });
    });

    const newTree = await rev(repo.dir, "HEAD^{tree}");
    expect(newTree).toBe(origTree);
  });

  it("agent-trailers fixture: rendered plan reports stripped patterns; apply still strips", async () => {
    const repo = track(await buildAgentTrailersFixture());
    await withCwd(repo.dir, async () => {
      await reshapeCommand({ logger: silent });
    });
    const planSrc = readFileSync(join(repo.dir, ".atropos/plan.md"), "utf8");
    expect(planSrc).toMatch(/strippedSummary/);
    expect(planSrc).toMatch(/Generated with|Co-authored-by/i);
  });

  it("apply rejects a stale plan (HEAD moved since plan generation)", async () => {
    const repo = track(await buildHappyFixture());
    await withCwd(repo.dir, async () => {
      await reshapeCommand({ logger: silent });
    });
    // Add an extra commit to advance HEAD
    await execa("git", ["commit", "-q", "--allow-empty", "-m", "stale-test"], {
      cwd: repo.dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" },
    });

    let caught: unknown;
    try {
      await withCwd(repo.dir, async () => {
        await applyCommand({ logger: silent });
      });
    } catch (err) {
      caught = err;
    }
    expect(isAtroposError(caught)).toBe(true);
    if (isAtroposError(caught)) {
      expect(caught.code).toBe("ERR_PLAN_PARSE");
    }
  });

  it("apply errors clearly when plan file is missing", async () => {
    const repo = track(await buildHappyFixture());
    let caught: unknown;
    try {
      await withCwd(repo.dir, async () => {
        await applyCommand({ logger: silent });
      });
    } catch (err) {
      caught = err;
    }
    expect(isAtroposError(caught)).toBe(true);
    if (isAtroposError(caught)) {
      expect(caught.code).toBe("ERR_PLAN_PARSE");
      expect(caught.message).toMatch(/plan file not found/);
    }
  });
});
