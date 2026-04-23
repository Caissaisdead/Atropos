import Anthropic from "@anthropic-ai/sdk";
import type { Sha } from "../git/types.js";
import { AtroposError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { BuiltPrompt } from "./prompt.js";
import { ClusterSchema, type ClusterInput } from "./schema.js";
import { validatePlan, type ValidationIssue } from "./validate.js";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 8192;

// Sonnet 4.6 reference pricing (USD per million tokens, April 2026 — adjust if pricing moves).
const PRICE_INPUT_PER_MTOK = 3;
const PRICE_OUTPUT_PER_MTOK = 15;
const PRICE_CACHE_WRITE_PER_MTOK = 3.75;
const PRICE_CACHE_READ_PER_MTOK = 0.3;

const ResponseSchema = z.object({
  clusters: z.array(ClusterSchema.passthrough()),
  dropped: z
    .array(z.object({ sha: z.string(), reason: z.string() }))
    .default([]),
  warnings: z.array(z.string()).default([]),
});

export interface LlmCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  latencyMs: number;
}

export interface LlmClient {
  call(input: { systemText: string; userText: string; model: string }): Promise<LlmCallResult>;
}

export interface ClusterWithLLMOptions {
  prompt: BuiltPrompt;
  liveOrMixedShas: Iterable<Sha>;
  model?: string;
  apiKey?: string;
  client?: LlmClient;
  logger?: Logger;
}

export interface ClusterWithLLMResult {
  clusters: ClusterInput[];
  dropped: Array<{ sha: string; reason: string }>;
  warnings: string[];
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  estimatedCostUsd: number;
}

export async function clusterWithLLM(opts: ClusterWithLLMOptions): Promise<ClusterWithLLMResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const client = opts.client ?? createAnthropicClient(opts.apiKey);
  const log = opts.logger;

  const userText = `${opts.prompt.schemaText}\n\n${opts.prompt.variableText}`;
  const first = await client.call({ systemText: opts.prompt.systemText, userText, model });
  logCall(log, model, first);

  const firstParsed = tryParseAndValidate(first.text, opts.liveOrMixedShas);
  if (firstParsed.ok) {
    return makeResult(firstParsed.value, [first]);
  }

  log?.warn(`LLM response failed validation, retrying once (${firstParsed.issues.length} issues)`);
  const retryUser = `${userText}\n\n<previous_response>${first.text}</previous_response>\n<validation_errors>\n${formatIssues(firstParsed.issues)}\n</validation_errors>\nFix the noted issues and re-emit the JSON Plan.`;
  const second = await client.call({ systemText: opts.prompt.systemText, userText: retryUser, model });
  logCall(log, model, second);

  const secondParsed = tryParseAndValidate(second.text, opts.liveOrMixedShas);
  if (secondParsed.ok) {
    return makeResult(secondParsed.value, [first, second]);
  }

  throw new AtroposError({
    code: "ERR_LLM_INVALID",
    what: "LLM returned an invalid plan after one retry",
    why: formatIssues(secondParsed.issues),
    fix: "edit `.atropos/plan.md` by hand, or re-run with `--no-cloud`",
  });
}

interface ParsedOk {
  ok: true;
  value: { clusters: ClusterInput[]; dropped: Array<{ sha: string; reason: string }>; warnings: string[] };
}
interface ParsedErr {
  ok: false;
  issues: Array<ValidationIssue | { code: "BAD_JSON"; message: string }>;
}
type Parsed = ParsedOk | ParsedErr;

function tryParseAndValidate(text: string, liveOrMixedShas: Iterable<Sha>): Parsed {
  const json = extractJson(text);
  if (!json) {
    return { ok: false, issues: [{ code: "BAD_JSON", message: "no JSON object found in response" }] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      issues: [{ code: "BAD_JSON", message: err instanceof Error ? err.message : String(err) }],
    };
  }
  const shape = ResponseSchema.safeParse(raw);
  if (!shape.success) {
    return {
      ok: false,
      issues: shape.error.issues.map((i) => ({
        code: "BAD_JSON",
        message: `${i.path.join(".") || "<root>"}: ${i.message}`,
      })),
    };
  }
  const clusters = shape.data.clusters as ClusterInput[];
  const issues = validatePlan(
    {
      version: 1,
      range: { base: "x", head: "x", baseRef: "x", headRef: "x" },
      generatedAt: "x",
      clusters,
      dropped: shape.data.dropped,
      warnings: shape.data.warnings,
      authorship: {
        targetAuthor: { name: "x", email: "x@example.com" },
        strippedSummary: [],
        preservedSummary: [],
      },
    } as never,
    { liveOrMixedShas },
  );
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { clusters, dropped: shape.data.dropped, warnings: shape.data.warnings },
  };
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  // Tolerate ```json ... ``` fences.
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fenced) return fenced[1] ?? null;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  return null;
}

function formatIssues(
  issues: Array<ValidationIssue | { code: "BAD_JSON"; message: string }>,
): string {
  return issues.slice(0, 10).map((i) => `- [${i.code}] ${i.message}`).join("\n");
}

function logCall(log: Logger | undefined, model: string, r: LlmCallResult): void {
  if (!log) return;
  const cost = estimateCost(r);
  const cache = r.cacheReadInputTokens
    ? ` cache_read=${r.cacheReadInputTokens}`
    : r.cacheCreationInputTokens
      ? ` cache_write=${r.cacheCreationInputTokens}`
      : "";
  log.info(
    `anthropic ${model} in=${r.inputTokens} out=${r.outputTokens}${cache} cost≈$${cost.toFixed(4)} ${r.latencyMs}ms`,
  );
}

function estimateCost(r: LlmCallResult): number {
  const baseInput = r.inputTokens / 1_000_000;
  const cacheRead = (r.cacheReadInputTokens ?? 0) / 1_000_000;
  const cacheWrite = (r.cacheCreationInputTokens ?? 0) / 1_000_000;
  const output = r.outputTokens / 1_000_000;
  return (
    baseInput * PRICE_INPUT_PER_MTOK +
    cacheRead * PRICE_CACHE_READ_PER_MTOK +
    cacheWrite * PRICE_CACHE_WRITE_PER_MTOK +
    output * PRICE_OUTPUT_PER_MTOK
  );
}

function makeResult(
  value: ParsedOk["value"],
  calls: readonly LlmCallResult[],
): ClusterWithLLMResult {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const c of calls) {
    input += c.inputTokens;
    output += c.outputTokens;
    cacheRead += c.cacheReadInputTokens ?? 0;
    cacheWrite += c.cacheCreationInputTokens ?? 0;
  }
  const tokens: ClusterWithLLMResult["tokens"] = { input, output };
  if (cacheRead > 0) tokens.cacheRead = cacheRead;
  if (cacheWrite > 0) tokens.cacheWrite = cacheWrite;
  const estimatedCostUsd = calls.reduce((sum, c) => sum + estimateCost(c), 0);
  return { ...value, tokens, estimatedCostUsd };
}

export function createAnthropicClient(apiKey?: string): LlmClient {
  const key = apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!key) {
    throw new AtroposError({
      code: "ERR_NO_API_KEY",
      what: "ANTHROPIC_API_KEY is not set",
      fix: "export ANTHROPIC_API_KEY=… or pass `--no-cloud`",
    });
  }
  const sdk = new Anthropic({ apiKey: key });
  return {
    async call({ systemText, userText, model }) {
      const t0 = Date.now();
      const response = await sdk.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userText }],
          },
        ],
      });
      const latencyMs = Date.now() - t0;
      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      const usage = response.usage;
      const out: LlmCallResult = {
        text,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        latencyMs,
      };
      if (usage.cache_creation_input_tokens != null) out.cacheCreationInputTokens = usage.cache_creation_input_tokens;
      if (usage.cache_read_input_tokens != null) out.cacheReadInputTokens = usage.cache_read_input_tokens;
      return out;
    },
  };
}
