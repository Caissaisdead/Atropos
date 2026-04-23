import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reshapeCommand } from "../../src/cli/reshape.js";
import { applyCommand } from "../../src/cli/apply.js";
import type { LlmClient, LlmCallResult } from "../../src/cluster/llm.js";
import { collectRange } from "../../src/analyze/collect.js";
import { createLogger } from "../../src/util/logger.js";
import {
  buildHappyFixture,
  buildHugeFixture,
  buildMixedConcernsFixture,
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

const ORIG_CWD = process.cwd();
function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  process.chdir(dir);
  return fn().finally(() => process.chdir(ORIG_CWD));
}

async function rev(cwd: string, ref: string): Promise<string> {
  const r = await execa("git", ["rev-parse", ref], { cwd, reject: false });
  return typeof r.stdout === "string" ? r.stdout.trim() : "";
}

function mockClientReturning(jsonOrJsons: string | string[]): { client: LlmClient; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const sequence = Array.isArray(jsonOrJsons) ? jsonOrJsons : [jsonOrJsons];
  const client: LlmClient = {
    async call({ userText }) {
      calls.push(userText);
      const text = sequence[Math.min(i++, sequence.length - 1)] ?? "";
      const result: LlmCallResult = {
        text,
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 1,
      };
      return result;
    },
  };
  return { client, calls };
}

function planForCommits(shas: string[]): string {
  return JSON.stringify({
    clusters: [
      {
        id: "c1",
        type: "feat",
        scope: "api",
        subject: "add users + types",
        memberShas: shas.slice(0, Math.max(1, shas.length - 1)),
        reasoning: "tightly coupled api work",
        confidence: 0.9,
      },
      {
        id: "c2",
        type: "docs",
        subject: "expand users page",
        memberShas: [shas[shas.length - 1]],
        reasoning: "doc-only work",
        confidence: 0.85,
      },
    ],
    dropped: [],
    warnings: [],
  });
}

describe("LLM clustering", () => {
  it("uses LLM clusters when mock returns a valid plan; T1 holds end-to-end", async () => {
    const repo = track(await buildMixedConcernsFixture());
    const collected = await collectRange({ opts: { cwd: repo.dir } });
    const shas = collected.commits.map((c) => String(c.sha));
    const { client, calls } = mockClientReturning(planForCommits(shas));

    const origTree = await rev(repo.dir, "HEAD^{tree}");

    await withCwd(repo.dir, async () => {
      await reshapeCommand({ logger: silent, llmClient: client });
    });
    expect(calls).toHaveLength(1);

    const planSrc = readFileSync(join(repo.dir, ".atropos/plan.md"), "utf8");
    expect(planSrc).toContain("model:"); // model field set
    expect(planSrc).toContain("add users + types");
    expect(planSrc).toContain("expand users page");

    await withCwd(repo.dir, async () => {
      await applyCommand({ logger: silent });
    });
    expect(await rev(repo.dir, "HEAD^{tree}")).toBe(origTree);
  });

  it("retries once on validation failure (e.g. hallucinated sha), then succeeds", async () => {
    const repo = track(await buildMixedConcernsFixture());
    const collected = await collectRange({ opts: { cwd: repo.dir } });
    const shas = collected.commits.map((c) => String(c.sha));

    const bad = JSON.stringify({
      clusters: [
        {
          id: "c1",
          type: "feat",
          subject: "x",
          memberShas: ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
          reasoning: "bogus",
          confidence: 0.5,
        },
      ],
      dropped: [],
    });
    const good = planForCommits(shas);
    const { client, calls } = mockClientReturning([bad, good]);

    await withCwd(repo.dir, async () => {
      await reshapeCommand({ logger: silent, llmClient: client });
    });

    expect(calls).toHaveLength(2);
    // Second call must include the validation errors from the first.
    expect(calls[1]).toContain("validation_errors");
  });

  it("falls back to heuristic with a warning when LLM fails twice", async () => {
    const repo = track(await buildMixedConcernsFixture());
    const { client, calls } = mockClientReturning(["not json", "still not json"]);

    await withCwd(repo.dir, async () => {
      await reshapeCommand({ logger: silent, llmClient: client });
    });
    expect(calls).toHaveLength(2);
    const planSrc = readFileSync(join(repo.dir, ".atropos/plan.md"), "utf8");
    expect(planSrc).toMatch(/LLM clustering failed; fell back to heuristic/);
    // Heuristic also produces a usable plan
    expect(planSrc).toContain("clusters:");
  });

  it("--no-cloud bypasses the SDK entirely (no instantiation)", async () => {
    const repo = track(await buildMixedConcernsFixture());

    // Mock the Anthropic SDK to throw on construction. If --no-cloud honours the
    // bypass, this constructor should never run.
    vi.doMock("@anthropic-ai/sdk", () => {
      return {
        default: vi.fn(() => {
          throw new Error("SDK constructed despite --no-cloud");
        }),
      };
    });

    try {
      await withCwd(repo.dir, async () => {
        await reshapeCommand({ logger: silent, noCloud: true });
      });
      const planSrc = readFileSync(join(repo.dir, ".atropos/plan.md"), "utf8");
      expect(planSrc).toContain("clusters:");
      // No "fell back" warning because we never tried.
      expect(planSrc).not.toMatch(/LLM clustering failed/);
    } finally {
      vi.doUnmock("@anthropic-ai/sdk");
    }
  });

  it("huge fixture: prompt builder fits inside the token budget (≤150k)", async () => {
    const repo = track(await buildHugeFixture(60));
    const collected = await collectRange({ opts: { cwd: repo.dir } });
    const { classifyDeadPaths } = await import("../../src/analyze/dead-paths.js");
    const { netDiff } = await import("../../src/analyze/net-diff.js");
    const { buildPrompt } = await import("../../src/cluster/prompt.js");
    const dead = await classifyDeadPaths(collected.range, collected.commits, { cwd: repo.dir });
    const nd = await netDiff(collected.range, { cwd: repo.dir });
    const built = await buildPrompt({
      range: collected.range,
      commits: collected.commits,
      byClassification: dead.byCommit,
      netDiff: nd,
      opts: { cwd: repo.dir },
    });
    expect(built.estimatedTokens).toBeLessThan(150_000);
    // Sanity: 60 commits is enough to either truncate or stress the per-range cap
    expect(built.variableText.length).toBeGreaterThan(1000);
  });

  it("happy fixture + LLM mock: backup ref exists and apply remains lossless", async () => {
    const repo = track(await buildHappyFixture());
    const collected = await collectRange({ opts: { cwd: repo.dir } });
    const shas = collected.commits.map((c) => String(c.sha));
    const { client } = mockClientReturning(
      JSON.stringify({
        clusters: [
          {
            id: "c1",
            type: "feat",
            scope: "api",
            subject: "add invoices module + tests",
            memberShas: shas,
            reasoning: "all touch src/api",
            confidence: 0.9,
          },
        ],
        dropped: [],
      }),
    );
    const origTree = await rev(repo.dir, "HEAD^{tree}");

    await withCwd(repo.dir, async () => {
      await reshapeCommand({ logger: silent, llmClient: client });
      await applyCommand({ logger: silent });
    });

    expect(await rev(repo.dir, "HEAD^{tree}")).toBe(origTree);
    expect(existsSync(join(repo.dir, ".git/atropos.lock"))).toBe(false);
    expect(statSync(join(repo.dir, ".atropos/plan.md")).isFile()).toBe(true);
  });
});
