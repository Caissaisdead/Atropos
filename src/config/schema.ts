import { z } from "zod";

// Minimal schema for v0.1.1: only `authorship.{author, normalize}` is honored.
// Unknown fields are accepted (passthrough) so users can keep forward-compatible
// stanzas (range, cluster, format, safety) per plan.md §9.1 without breaking validation
// when v0.2 wires the rest.
export const AtroposConfigSchema = z
  .object({
    authorship: z
      .object({
        author: z.string().nullable().optional(),
        normalize: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AtroposConfig = z.infer<typeof AtroposConfigSchema>;

export const CONFIG_FILENAME = ".atropos.json";
