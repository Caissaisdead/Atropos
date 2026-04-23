import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../../src/util/logger.js";

function captureStream() {
  const s = new PassThrough();
  const chunks: string[] = [];
  s.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  return { stream: s, output: () => chunks.join("") };
}

describe("redact", () => {
  it("redacts Anthropic API keys from arbitrary strings", () => {
    const key = "sk-ant-" + "A".repeat(40);
    expect(redact(`Authorization: Bearer ${key}`)).toBe(
      "Authorization: Bearer sk-ant-***",
    );
  });

  it("leaves non-key strings untouched", () => {
    expect(redact("nothing to see here")).toBe("nothing to see here");
  });

  it("redacts multiple occurrences", () => {
    const key1 = "sk-ant-" + "A".repeat(30);
    const key2 = "sk-ant-" + "B".repeat(30);
    expect(redact(`${key1} and ${key2}`)).toBe("sk-ant-*** and sk-ant-***");
  });
});

describe("logger levels", () => {
  it("respects level threshold", () => {
    const { stream, output } = captureStream();
    const log = createLogger({ level: "warn", stream, color: false });
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    const out = output();
    expect(out).toContain("e");
    expect(out).toContain("w");
    expect(out).not.toContain("i");
    expect(out).not.toContain("d");
  });

  it("applies child prefix", () => {
    const { stream, output } = captureStream();
    const log = createLogger({ level: "info", stream, color: false }).child("[git]");
    log.info("ran");
    expect(output()).toContain("[git] ran");
  });

  it("redacts API keys in messages and rest args", () => {
    const { stream, output } = captureStream();
    const log = createLogger({ level: "info", stream, color: false });
    const key = "sk-ant-" + "Z".repeat(40);
    log.info(`key=${key}`);
    log.info("kv", { token: key });
    const out = output();
    expect(out).not.toContain(key);
    expect(out).toContain("sk-ant-***");
  });
});
