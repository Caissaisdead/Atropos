import { describe, expect, it } from "vitest";
import { parseMeta, parseRawAndNumstat, splitMessage } from "../../src/git/commits.js";

describe("splitMessage", () => {
  it("splits subject from empty body", () => {
    const r = splitMessage("just a subject");
    expect(r.subject).toBe("just a subject");
    expect(r.body).toBe("");
    expect(r.trailers).toEqual([]);
  });

  it("extracts a trailer block", () => {
    const r = splitMessage(
      "feat: add invoices\n\nbody paragraph here\n\nCo-authored-by: Sid <sid@example.com>\nSigned-off-by: Sid <sid@example.com>",
    );
    expect(r.subject).toBe("feat: add invoices");
    expect(r.body).toBe("body paragraph here");
    expect(r.trailers).toHaveLength(2);
    expect(r.trailers[0]).toEqual({
      key: "Co-authored-by",
      value: "Sid <sid@example.com>",
      raw: "Co-authored-by: Sid <sid@example.com>",
    });
  });

  it("treats non-trailer last paragraph as body", () => {
    const r = splitMessage(
      "fix: thing\n\nbody one\n\nbody two with prose, not trailers",
    );
    expect(r.body).toBe("body one\n\nbody two with prose, not trailers");
    expect(r.trailers).toEqual([]);
  });

  it("handles a body that is only trailers", () => {
    const r = splitMessage("subject\n\nFixes: #1\nRefs: #2");
    expect(r.body).toBe("");
    expect(r.trailers.map((t) => t.key)).toEqual(["Fixes", "Refs"]);
  });
});

describe("parseMeta", () => {
  it("parses git show -s output", () => {
    const raw = [
      "abc123def456",
      "deadbeef cafebabe",
      "Sid Nigam",
      "sid@example.com",
      "2026-04-21T14:32:00Z",
      "Sid Nigam",
      "sid@example.com",
      "2026-04-21T14:32:05Z",
      "feat(api): add invoices",
      "",
      "body line 1",
      "",
      "Co-authored-by: Priya <priya@example.com>",
    ].join("\n");
    const m = parseMeta(raw);
    expect(m.sha).toBe("abc123def456");
    expect(m.parents).toEqual(["deadbeef", "cafebabe"]);
    expect(m.author).toEqual({ name: "Sid Nigam", email: "sid@example.com" });
    expect(m.committer).toEqual({ name: "Sid Nigam", email: "sid@example.com" });
    expect(m.authoredAt).toBe("2026-04-21T14:32:00Z");
    expect(m.subject).toBe("feat(api): add invoices");
    expect(m.body).toBe("body line 1");
    expect(m.trailers).toHaveLength(1);
    expect(m.trailers[0]?.key).toBe("Co-authored-by");
  });
});

describe("parseRawAndNumstat", () => {
  it("parses combined --raw + --numstat output", () => {
    const raw = [
      ":100644 100644 abc123 def456 M\tsrc/foo.ts",
      ":000000 100644 0000000 abc123 A\tsrc/bar.ts",
      ":100644 000000 abc123 0000000 D\tsrc/baz.ts",
      "",
      "10\t2\tsrc/foo.ts",
      "120\t0\tsrc/bar.ts",
      "0\t40\tsrc/baz.ts",
    ].join("\n");
    const files = parseRawAndNumstat(raw);
    expect(files).toHaveLength(3);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["src/foo.ts"]).toMatchObject({
      added: 10,
      deleted: 2,
      status: "M",
    });
    expect(byPath["src/bar.ts"]).toMatchObject({
      added: 120,
      deleted: 0,
      status: "A",
    });
    expect(byPath["src/baz.ts"]).toMatchObject({ added: 0, deleted: 40, status: "D" });
  });

  it("treats binary files (added=-) as 0", () => {
    const raw = "-\t-\tassets/img.png";
    const files = parseRawAndNumstat(raw);
    expect(files[0]).toMatchObject({ added: 0, deleted: 0, path: "assets/img.png" });
  });

  it("captures rename oldPath (plain form)", () => {
    const raw = [
      ":100644 100644 abc def R100\tsrc/old.ts\ttests/new.ts",
      "",
      "0\t0\tsrc/old.ts => tests/new.ts",
    ].join("\n");
    const files = parseRawAndNumstat(raw);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("tests/new.ts");
    expect(files[0]?.oldPath).toBe("src/old.ts");
    expect(files[0]?.status).toBe("R");
  });

  it("captures rename oldPath (brace-collapsed form)", () => {
    const raw = [
      ":100644 100644 abc def R100\tsrc/old.ts\tsrc/new.ts",
      "",
      "0\t0\tsrc/{old.ts => new.ts}",
    ].join("\n");
    const files = parseRawAndNumstat(raw);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/new.ts");
    expect(files[0]?.oldPath).toBe("src/old.ts");
    expect(files[0]?.status).toBe("R");
  });

  it("handles brace form with common suffix", () => {
    const raw = [
      ":100644 100644 abc def R100\told/foo.ts\tnew/foo.ts",
      "",
      "1\t1\t{old => new}/foo.ts",
    ].join("\n");
    const files = parseRawAndNumstat(raw);
    expect(files[0]?.path).toBe("new/foo.ts");
    expect(files[0]?.oldPath).toBe("old/foo.ts");
  });
});
