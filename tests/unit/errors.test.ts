import { describe, expect, it } from "vitest";
import { AtroposError, isAtroposError } from "../../src/util/errors.js";

describe("AtroposError", () => {
  it("formats message as <code>: <what> — <why> — <fix>", () => {
    const err = new AtroposError({
      code: "ERR_DIRTY",
      what: "working tree has uncommitted changes",
      why: "atropos refuses to reshape over uncommitted work",
      fix: "commit, stash, or pass --allow-dirty",
    });
    expect(err.message).toBe(
      "ERR_DIRTY: working tree has uncommitted changes — atropos refuses to reshape over uncommitted work — commit, stash, or pass --allow-dirty",
    );
  });

  it("omits why and fix when not provided", () => {
    const err = new AtroposError({ code: "ERR_UNKNOWN", what: "boom" });
    expect(err.message).toBe("ERR_UNKNOWN: boom");
  });

  it("maps codes to spec exit codes", () => {
    expect(new AtroposError({ code: "ERR_BAD_RANGE", what: "x" }).exitCode).toBe(2);
    expect(new AtroposError({ code: "ERR_NO_API_KEY", what: "x" }).exitCode).toBe(10);
    expect(new AtroposError({ code: "ERR_LLM_INVALID", what: "x" }).exitCode).toBe(21);
    expect(new AtroposError({ code: "ERR_PUSHED", what: "x" }).exitCode).toBe(31);
    expect(new AtroposError({ code: "ERR_CONFLICT", what: "x" }).exitCode).toBe(32);
    expect(new AtroposError({ code: "ERR_TREE_MISMATCH", what: "x" }).exitCode).toBe(33);
    expect(new AtroposError({ code: "ERR_LOCKED", what: "x" }).exitCode).toBe(40);
    expect(new AtroposError({ code: "ERR_INTERRUPTED", what: "x" }).exitCode).toBe(130);
  });

  it("preserves cause", () => {
    const cause = new Error("inner");
    const err = new AtroposError({ code: "ERR_UNKNOWN", what: "outer", cause });
    expect(err.cause).toBe(cause);
  });

  it("isAtroposError narrows correctly", () => {
    expect(isAtroposError(new AtroposError({ code: "ERR_UNKNOWN", what: "x" }))).toBe(true);
    expect(isAtroposError(new Error("plain"))).toBe(false);
    expect(isAtroposError("string")).toBe(false);
  });
});
