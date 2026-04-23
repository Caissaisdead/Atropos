import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runApply } from "../../src/apply/run.js";
import { isAtroposError } from "../../src/util/errors.js";
import { createLogger } from "../../src/util/logger.js";
import * as promoteModule from "../../src/apply/promote.js";
import {
  buildConflictFixture,
  buildHappyFixture,
  buildPushedFixture,
  type FixtureRepo,
} from "../fixtures/build.js";

vi.mock("../../src/apply/promote.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/apply/promote.js")>();
  return { ...actual };
});

const cleanups: Array<() => void> = [];
const silent = createLogger({ level: "error", color: false, stream: process.stderr });

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function track(repo: FixtureRepo): FixtureRepo {
  cleanups.push(repo.cleanup);
  return repo;
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await execa("git", args, { cwd, reject: false, encoding: "utf8" });
  return typeof r.stdout === "string" ? r.stdout.trim() : "";
}

async function rev(cwd: string, ref: string): Promise<string> {
  return git(["rev-parse", ref], cwd);
}

describe("safety vertical slice", () => {
  it("happy fixture: T1 tree-equality, T6 backup ref, T7 no lock", async () => {
    const repo = track(await buildHappyFixture());
    const origHead = await rev(repo.dir, "HEAD");
    const origTree = await rev(repo.dir, "HEAD^{tree}");

    const result = await runApply({ cwd: repo.dir, logger: silent });

    const newHead = await rev(repo.dir, "HEAD");
    const newTree = await rev(repo.dir, "HEAD^{tree}");
    const backupTree = await rev(repo.dir, `${result.backupRef}^{tree}`);
    const backupSha = await rev(repo.dir, result.backupRef);

    // T1: reshaped tree byte-matches the original tree
    expect(newTree).toBe(origTree);
    expect(backupTree).toBe(origTree);

    // T6: backup ref exists and points at pre-apply head
    expect(backupSha).toBe(origHead);

    // T7: no lock left behind
    expect(existsSync(join(repo.dir, ".git/atropos.lock"))).toBe(false);

    // sanity: branch ref moved (different commit shas, identical tree)
    expect(newHead).not.toBe(origHead);
    expect(result.clustersApplied).toBeGreaterThan(0);
  });

  it("pushed fixture: refuses with ERR_PUSHED, leaves repo untouched", async () => {
    const repo = track(await buildPushedFixture());
    const origHead = await rev(repo.dir, "HEAD");

    let caught: unknown;
    try {
      await runApply({ cwd: repo.dir, logger: silent });
    } catch (err) {
      caught = err;
    }

    expect(isAtroposError(caught)).toBe(true);
    if (isAtroposError(caught)) {
      expect(caught.code).toBe("ERR_PUSHED");
      expect(caught.exitCode).toBe(31);
    }

    expect(await rev(repo.dir, "HEAD")).toBe(origHead);
    expect(existsSync(join(repo.dir, ".git/atropos.lock"))).toBe(false);

    const backupOut = await git(
      ["for-each-ref", "refs/heads/atropos/backup-*", "--count=1"],
      repo.dir,
    );
    expect(backupOut).toBe("");
  });

  it("pushed fixture: --rewrite-pushed bypasses the check", async () => {
    const repo = track(await buildPushedFixture());
    const origTree = await rev(repo.dir, "HEAD^{tree}");
    const result = await runApply({
      cwd: repo.dir,
      rewritePushed: true,
      logger: silent,
    });
    const newTree = await rev(repo.dir, "HEAD^{tree}");
    expect(newTree).toBe(origTree);
    expect(result.clustersApplied).toBeGreaterThan(0);
  });

  it("conflict fixture: drops parent, raises ERR_CONFLICT, rolls back cleanly", async () => {
    const built = await buildConflictFixture();
    cleanups.push(built.repo.cleanup);
    const origHead = await rev(built.repo.dir, "HEAD");

    let caught: unknown;
    try {
      await runApply({
        cwd: built.repo.dir,
        clusters: [
          {
            id: "c1",
            type: "feat",
            subject: "extend c.ts",
            memberShas: [built.childSha as never],
          },
        ],
        logger: silent,
      });
    } catch (err) {
      caught = err;
    }

    expect(isAtroposError(caught)).toBe(true);
    if (isAtroposError(caught)) {
      expect(caught.code).toBe("ERR_CONFLICT");
      expect(caught.exitCode).toBe(32);
    }

    // Branch unmoved, no work ref, no lock — rollback is clean.
    expect(await rev(built.repo.dir, "HEAD")).toBe(origHead);
    expect(existsSync(join(built.repo.dir, ".git/atropos.lock"))).toBe(false);

    const onBranch = await git(["symbolic-ref", "--short", "HEAD"], built.repo.dir);
    expect(onBranch).toBe(built.repo.branch);

    // No leftover atropos/work-* refs
    const work = await git(
      ["for-each-ref", "refs/heads/atropos/work-*", "--count=1"],
      built.repo.dir,
    );
    expect(work).toBe("");
  });

  it("failure injection: rollback restores original branch when promote fails", async () => {
    const repo = track(await buildHappyFixture());
    const origHead = await rev(repo.dir, "HEAD");
    const origTree = await rev(repo.dir, "HEAD^{tree}");

    const sentinel = new Error("synthetic promote failure");
    const spy = vi
      .spyOn(promoteModule, "promote")
      .mockImplementation(async () => {
        throw sentinel;
      });

    let caught: unknown;
    try {
      await runApply({ cwd: repo.dir, logger: silent });
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }

    expect(caught).toBe(sentinel);
    expect(await rev(repo.dir, "HEAD")).toBe(origHead);
    expect(await rev(repo.dir, "HEAD^{tree}")).toBe(origTree);
    expect(existsSync(join(repo.dir, ".git/atropos.lock"))).toBe(false);

    const work = await git(
      ["for-each-ref", "refs/heads/atropos/work-*", "--count=1"],
      repo.dir,
    );
    expect(work).toBe("");
  });
});
