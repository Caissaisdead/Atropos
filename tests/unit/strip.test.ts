import { describe, expect, it } from "vitest";
import { cleanMessage, isBotIdentity } from "../../src/authorship/strip.js";
import type { Trailer } from "../../src/git/types.js";

function trailer(raw: string): Trailer {
  const idx = raw.indexOf(":");
  return { key: raw.slice(0, idx), value: raw.slice(idx + 2), raw };
}

describe("cleanMessage — strip patterns", () => {
  it("strips Co-authored-by: Claude", () => {
    const r = cleanMessage({
      subject: "feat: x",
      body: "",
      trailers: [trailer("Co-authored-by: Claude <noreply@anthropic.com>")],
    });
    expect(r.preservedTrailers).toHaveLength(0);
    expect(r.strippedTrailers).toHaveLength(1);
    expect(r.stripStats[0]?.count).toBe(1);
  });

  it("strips Co-authored-by: Copilot", () => {
    const r = cleanMessage({
      subject: "x",
      body: "",
      trailers: [trailer("Co-authored-by: GitHub Copilot <copilot@github.com>")],
    });
    expect(r.strippedTrailers).toHaveLength(1);
  });

  it("strips Co-authored-by: ...[bot]...", () => {
    const r = cleanMessage({
      subject: "x",
      body: "",
      trailers: [trailer("Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>")],
    });
    expect(r.strippedTrailers).toHaveLength(1);
  });

  it("preserves real Co-authored-by — zero false positives (the trust test)", () => {
    const r = cleanMessage({
      subject: "x",
      body: "",
      trailers: [trailer("Co-authored-by: Priya Patel <priya@example.com>")],
    });
    expect(r.strippedTrailers).toHaveLength(0);
    expect(r.preservedTrailers).toHaveLength(1);
  });

  it("preserves Signed-off-by", () => {
    const r = cleanMessage({
      subject: "x",
      body: "",
      trailers: [trailer("Signed-off-by: Sid <sid@example.com>")],
    });
    expect(r.preservedTrailers).toHaveLength(1);
  });

  it("strips 🤖 Generated with [Claude Code] footer line", () => {
    const r = cleanMessage({
      subject: "feat: x",
      body: "real body line\n\n🤖 Generated with [Claude Code](https://claude.ai/code)",
      trailers: [],
    });
    expect(r.strippedFooterLines.length).toBeGreaterThanOrEqual(1);
    expect(r.body).toBe("real body line");
  });

  it("strips claude.ai/code link lines", () => {
    const r = cleanMessage({
      subject: "x",
      body: "Here is the work.\nSee https://claude.ai/code/session-12345 for details.",
      trailers: [],
    });
    expect(r.body).toBe("Here is the work.");
  });

  it("leaves a clean message untouched", () => {
    const r = cleanMessage({
      subject: "feat: clean subject",
      body: "real body\n\nmore body",
      trailers: [trailer("Closes: #42")],
    });
    expect(r.subject).toBe("feat: clean subject");
    expect(r.body).toBe("real body\n\nmore body");
    expect(r.preservedTrailers).toHaveLength(1);
    expect(r.strippedTrailers).toHaveLength(0);
    expect(r.strippedFooterLines).toHaveLength(0);
  });
});

describe("isBotIdentity", () => {
  it("flags Claude noreply", () => {
    expect(isBotIdentity({ name: "Claude", email: "noreply@anthropic.com" })).toBe(true);
  });

  it("flags github [bot] noreply", () => {
    expect(
      isBotIdentity({
        name: "dependabot[bot]",
        email: "49699333+dependabot[bot]@users.noreply.github.com",
      }),
    ).toBe(true);
  });

  it("does not flag a regular human email", () => {
    expect(isBotIdentity({ name: "Sid", email: "sid@example.com" })).toBe(false);
  });
});
