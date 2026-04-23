import { z } from "zod";

export const COMMIT_TYPES = [
  "feat",
  "fix",
  "refactor",
  "chore",
  "test",
  "docs",
  "perf",
  "build",
  "ci",
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

export const ClusterSchema = z.object({
  id: z.string().min(1),
  type: z.enum(COMMIT_TYPES),
  scope: z.string().optional(),
  subject: z.string().min(1).max(72),
  body: z.string().optional(),
  memberShas: z.array(z.string().min(7)).min(1),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type ClusterInput = z.infer<typeof ClusterSchema>;

export const DroppedSchema = z.object({
  sha: z.string().min(7),
  reason: z.string().min(1),
});

export const AuthorshipSchema = z.object({
  targetAuthor: z.object({
    name: z.string().min(1),
    email: z.string().email(),
  }),
  strippedSummary: z
    .array(
      z.object({
        pattern: z.string(),
        count: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  preservedSummary: z
    .array(
      z.object({
        key: z.string(),
        count: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});

export const PlanDocumentSchema = z.object({
  version: z.literal(1),
  range: z.object({
    base: z.string().min(7),
    head: z.string().min(7),
    baseRef: z.string().min(1),
    headRef: z.string().min(1),
  }),
  generatedAt: z.string().min(1),
  model: z.string().optional(),
  clusters: z.array(ClusterSchema),
  dropped: z.array(DroppedSchema).default([]),
  warnings: z.array(z.string()).default([]),
  authorship: AuthorshipSchema,
});

export type PlanDocument = z.infer<typeof PlanDocumentSchema>;
