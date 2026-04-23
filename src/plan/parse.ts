import YAML from "yaml";
import { z } from "zod";
import { parseAuthor } from "../authorship/identity.js";
import { ClusterSchema, DroppedSchema, PlanDocumentSchema, type PlanDocument } from "../cluster/schema.js";
import { AtroposError } from "../util/errors.js";
import { PLAN_BEGIN, PLAN_END } from "./render.js";

// Strict on-disk schema: targetAuthor is rendered as "Name <email>" and the
// schema is closed (no unknown keys) so hand edits surface clearly.
const OnDiskPlanSchema = z
  .object({
    version: z.literal(1),
    range: z
      .object({
        base: z.string().min(7),
        head: z.string().min(7),
        baseRef: z.string().min(1),
        headRef: z.string().min(1),
      })
      .strict(),
    generatedAt: z.string().min(1),
    model: z.string().optional(),
    authorship: z
      .object({
        targetAuthor: z.string().min(1),
        strippedSummary: z.array(z.object({ pattern: z.string(), count: z.number() })).default([]),
        preservedSummary: z.array(z.object({ key: z.string(), count: z.number() })).default([]),
      })
      .strict(),
    clusters: z.array(ClusterSchema.strict()),
    dropped: z.array(DroppedSchema.strict()).default([]),
    warnings: z.array(z.string()).default([]),
  })
  .strict();

export function parsePlan(source: string): PlanDocument {
  const yamlBlock = extractYamlBlock(source);
  let raw: unknown;
  try {
    raw = YAML.parse(yamlBlock);
  } catch (err) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: "could not parse YAML in plan",
      why: err instanceof Error ? err.message : String(err),
      fix: "fix the YAML syntax in the atropos:begin block",
    });
  }
  const parsed = OnDiskPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: "plan YAML failed validation",
      why: formatZodIssues(parsed.error),
      fix: "fix the highlighted keys; unknown keys are rejected on purpose",
    });
  }

  const target = parseAuthor(parsed.data.authorship.targetAuthor);
  if (!target) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: `authorship.targetAuthor '${parsed.data.authorship.targetAuthor}' is not in 'Name <email>' form`,
      fix: "edit the plan to use 'Name <email>'",
    });
  }

  const out: PlanDocument = {
    version: 1,
    range: parsed.data.range,
    generatedAt: parsed.data.generatedAt,
    clusters: parsed.data.clusters,
    dropped: parsed.data.dropped,
    warnings: parsed.data.warnings,
    authorship: {
      targetAuthor: target,
      strippedSummary: parsed.data.authorship.strippedSummary,
      preservedSummary: parsed.data.authorship.preservedSummary,
    },
  };
  if (parsed.data.model !== undefined) out.model = parsed.data.model;

  // Final validation against the canonical schema (covers max-72 subject etc.).
  const final = PlanDocumentSchema.safeParse(out);
  if (!final.success) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: "plan failed canonical validation",
      why: formatZodIssues(final.error),
      fix: "fix the noted fields",
    });
  }
  return final.data;
}

function extractYamlBlock(source: string): string {
  const beginIdx = source.indexOf(PLAN_BEGIN);
  if (beginIdx < 0) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: `plan is missing the '${PLAN_BEGIN}' marker`,
      fix: "do not delete the marker — it bookends the YAML block atropos parses",
    });
  }
  const endIdx = source.indexOf(PLAN_END, beginIdx);
  if (endIdx < 0) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: `plan is missing the '${PLAN_END}' marker`,
      fix: "restore both atropos:begin and atropos:end fences around the YAML",
    });
  }
  const inner = source.slice(beginIdx + PLAN_BEGIN.length, endIdx);
  // Expect a fenced ```yaml ... ``` block inside.
  const fenceOpen = inner.indexOf("```");
  const fenceClose = inner.lastIndexOf("```");
  if (fenceOpen < 0 || fenceClose <= fenceOpen) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: "atropos block is missing its ```yaml fence",
      fix: "wrap the YAML in ```yaml ... ``` between the atropos markers",
    });
  }
  const headerEnd = inner.indexOf("\n", fenceOpen + 3);
  return inner.slice(headerEnd + 1, fenceClose).trim() + "\n";
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
