import { describe, expect, it } from "vitest";
import type { PlanDocument } from "../../src/cluster/schema.js";
import { parsePlan } from "../../src/plan/parse.js";
import { renderPlan } from "../../src/plan/render.js";

const samplePlan: PlanDocument = {
  version: 1,
  range: {
    base: "a1b2c3d4e5f6",
    head: "f6e5d4c3b2a1",
    baseRef: "main",
    headRef: "feature/invoices",
  },
  generatedAt: "2026-04-21T14:32:00Z",
  model: "claude-sonnet-4-6",
  clusters: [
    {
      id: "c1",
      type: "feat",
      scope: "api",
      subject: "add /invoices endpoint",
      body: "Wires up the GET /invoices route and a basic in-memory store.",
      memberShas: ["a1b2c3d4e5f6", "deadbeefcafe1234"],
      reasoning: "both touch src/api/invoices.ts and the router; tests landed separately",
      confidence: 0.92,
    },
    {
      id: "c2",
      type: "test",
      scope: "api",
      subject: "cover /invoices happy + error paths",
      memberShas: ["1111111aaaaaa", "2222222bbbbbb"],
      reasoning: "test files only",
      confidence: 0.88,
    },
  ],
  dropped: [
    { sha: "9999999cccccc", reason: "wip — merged into c1" },
    { sha: "8888888dddddd", reason: "revert of dead-end middleware experiment" },
  ],
  warnings: ["one cluster contains a >400-line diff; clustering quality may be reduced"],
  authorship: {
    targetAuthor: { name: "Sid Nigam", email: "sid@example.com" },
    strippedSummary: [
      { pattern: "Co-authored-by: Claude", count: 9 },
      { pattern: "🤖 Generated with", count: 9 },
    ],
    preservedSummary: [{ key: "Closes", count: 1 }],
  },
};

describe("plan render/parse round-trip", () => {
  it("render → parse yields the original plan", () => {
    const rendered = renderPlan({ plan: samplePlan, totalCommitsInRange: 9 });
    const parsed = parsePlan(rendered);
    expect(parsed).toEqual(samplePlan);
  });

  it("render → parse → render is a fixed point", () => {
    const rendered1 = renderPlan({ plan: samplePlan, totalCommitsInRange: 9 });
    const parsed1 = parsePlan(rendered1);
    const rendered2 = renderPlan({ plan: parsed1, totalCommitsInRange: 9 });
    expect(rendered2).toBe(rendered1);
  });

  it("rejects plan with missing atropos:begin marker", () => {
    expect(() => parsePlan("just markdown, no fence\n")).toThrow(/atropos:begin/);
  });

  it("rejects plan with unknown YAML keys", () => {
    const rendered = renderPlan({ plan: samplePlan, totalCommitsInRange: 9 });
    const tampered = rendered.replace("version: 1", "version: 1\nbogus_root_key: 42");
    expect(() => parsePlan(tampered)).toThrow();
  });

  it("rejects plan with subject > 72 chars", () => {
    const bad: PlanDocument = JSON.parse(JSON.stringify(samplePlan));
    bad.clusters[0]!.subject = "x".repeat(80);
    const rendered = renderPlan({ plan: bad, totalCommitsInRange: 9 });
    expect(() => parsePlan(rendered)).toThrow();
  });

  it("rejects targetAuthor not in 'Name <email>' form", () => {
    const rendered = renderPlan({ plan: samplePlan, totalCommitsInRange: 9 });
    const tampered = rendered.replace(
      /targetAuthor: ".*"/,
      'targetAuthor: "no-email-here"',
    );
    expect(() => parsePlan(tampered)).toThrow(/Name <email>/);
  });
});
