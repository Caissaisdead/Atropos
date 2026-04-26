import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitTopLevel } from "../git/guards.js";
import { AtroposError } from "../util/errors.js";
import { AtroposConfigSchema, CONFIG_FILENAME, type AtroposConfig } from "./schema.js";

export interface LoadConfigOptions {
  cwd?: string;
}

export async function loadAtroposConfig(
  opts: LoadConfigOptions = {},
): Promise<AtroposConfig | null> {
  let root: string;
  try {
    root = opts.cwd ?? (await gitTopLevel({}));
  } catch {
    return null;
  }
  const path = join(root, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AtroposError({
      code: "ERR_CONFIG_INVALID",
      what: `${CONFIG_FILENAME} is not valid JSON`,
      why: detail,
      fix: `fix the JSON at ${path}, or remove the file`,
    });
  }
  const result = AtroposConfigSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new AtroposError({
      code: "ERR_CONFIG_INVALID",
      what: `${CONFIG_FILENAME} failed schema validation`,
      why: issues,
      fix: `correct ${path} per the schema in plan.md §9.1`,
    });
  }
  return result.data;
}
