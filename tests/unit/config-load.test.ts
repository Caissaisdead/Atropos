import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAtroposConfig } from "../../src/config/load.js";
import { isAtroposError } from "../../src/util/errors.js";

describe("loadAtroposConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atropos-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when .atropos.json is absent", async () => {
    const cfg = await loadAtroposConfig({ cwd: dir });
    expect(cfg).toBeNull();
  });

  it("parses authorship.author", async () => {
    writeFileSync(
      join(dir, ".atropos.json"),
      JSON.stringify({ authorship: { author: "Sid <sid@example.com>" } }),
    );
    const cfg = await loadAtroposConfig({ cwd: dir });
    expect(cfg?.authorship?.author).toBe("Sid <sid@example.com>");
  });

  it("parses authorship.normalize: false", async () => {
    writeFileSync(
      join(dir, ".atropos.json"),
      JSON.stringify({ authorship: { normalize: false } }),
    );
    const cfg = await loadAtroposConfig({ cwd: dir });
    expect(cfg?.authorship?.normalize).toBe(false);
  });

  it("accepts unknown top-level stanzas (passthrough for forward compat)", async () => {
    writeFileSync(
      join(dir, ".atropos.json"),
      JSON.stringify({
        authorship: { normalize: true },
        cluster: { model: "claude-sonnet-4-6" },
        safety: { refuseOnPushed: true },
      }),
    );
    const cfg = await loadAtroposConfig({ cwd: dir });
    expect(cfg?.authorship?.normalize).toBe(true);
  });

  it("throws ERR_CONFIG_INVALID on malformed JSON", async () => {
    writeFileSync(join(dir, ".atropos.json"), "{ not json");
    await expect(loadAtroposConfig({ cwd: dir })).rejects.toSatisfy((err) => {
      if (!isAtroposError(err)) return false;
      return err.code === "ERR_CONFIG_INVALID";
    });
  });

  it("throws ERR_CONFIG_INVALID when authorship.normalize is wrong type", async () => {
    writeFileSync(
      join(dir, ".atropos.json"),
      JSON.stringify({ authorship: { normalize: "yes" } }),
    );
    await expect(loadAtroposConfig({ cwd: dir })).rejects.toSatisfy((err) => {
      if (!isAtroposError(err)) return false;
      return err.code === "ERR_CONFIG_INVALID";
    });
  });
});
