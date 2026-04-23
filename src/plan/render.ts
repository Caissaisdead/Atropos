import YAML from "yaml";
import type { PlanDocument } from "../cluster/schema.js";

const BEGIN = "<!-- atropos:begin -->";
const END = "<!-- atropos:end -->";

export interface RenderInput {
  plan: PlanDocument;
  totalCommitsInRange: number;
}

export function renderPlan(input: RenderInput): string {
  const meta = serializeMeta(input.plan);
  const md = renderMarkdown(input);
  return `${BEGIN}\n\`\`\`yaml\n${meta}\`\`\`\n${END}\n\n${md}\n`;
}

function serializeMeta(plan: PlanDocument): string {
  const meta: Record<string, unknown> = {
    version: plan.version,
    range: plan.range,
    generatedAt: plan.generatedAt,
  };
  if (plan.model) meta["model"] = plan.model;
  meta["authorship"] = {
    targetAuthor: `${plan.authorship.targetAuthor.name} <${plan.authorship.targetAuthor.email}>`,
    strippedSummary: plan.authorship.strippedSummary,
    preservedSummary: plan.authorship.preservedSummary,
  };
  meta["clusters"] = plan.clusters.map((c) => {
    const out: Record<string, unknown> = {
      id: c.id,
      type: c.type,
    };
    if (c.scope) out["scope"] = c.scope;
    out["subject"] = c.subject;
    if (c.body) out["body"] = c.body;
    out["memberShas"] = c.memberShas;
    out["confidence"] = c.confidence;
    out["reasoning"] = c.reasoning;
    return out;
  });
  meta["dropped"] = plan.dropped;
  meta["warnings"] = plan.warnings;
  return YAML.stringify(meta, {
    lineWidth: 0,
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
  });
}

function renderMarkdown(input: RenderInput): string {
  const { plan, totalCommitsInRange } = input;
  const author = plan.authorship.targetAuthor;
  const lines: string[] = [
    `# Atropos plan`,
    "",
    `**Range:** \`${plan.range.baseRef}..${plan.range.headRef}\` (${totalCommitsInRange} commits)`,
    `**Generated:** ${plan.generatedAt}${plan.model ? ` · model: ${plan.model}` : ""}`,
    `**Backup will be created at:** \`atropos/backup-<ISO>\``,
    "",
    `## Authorship`,
    "",
    `**Target author:** \`${author.name} <${author.email}>\``,
  ];

  if (plan.authorship.strippedSummary.length > 0) {
    lines.push(`**Stripped across range:**`);
    for (const s of plan.authorship.strippedSummary) {
      lines.push(`- ${s.count} × \`${s.pattern}\``);
    }
  } else {
    lines.push("*No agent attribution detected.*");
  }
  if (plan.authorship.preservedSummary.length > 0) {
    lines.push("");
    lines.push("**Preserved trailers:**");
    for (const p of plan.authorship.preservedSummary) {
      lines.push(`- ${p.count} × \`${p.key}\``);
    }
  }

  lines.push("");
  lines.push(`## Proposed history (${plan.clusters.length} commits)`);
  lines.push("");

  for (let i = 0; i < plan.clusters.length; i++) {
    const c = plan.clusters[i]!;
    const subject = c.scope ? `${c.type}(${c.scope}): ${c.subject}` : `${c.type}: ${c.subject}`;
    lines.push(`### ${i + 1}. \`${subject}\``);
    lines.push("");
    lines.push(`Members: ${c.memberShas.map((s) => `\`${s.slice(0, 7)}\``).join(", ")}`);
    lines.push(`Confidence: ${c.confidence.toFixed(2)}`);
    if (c.reasoning) {
      lines.push("");
      lines.push(`*Why:* ${c.reasoning}`);
    }
    if (c.body) {
      lines.push("");
      lines.push(c.body);
    }
    lines.push("");
  }

  if (plan.dropped.length > 0) {
    lines.push(`## Dropped (${plan.dropped.length})`);
    lines.push("");
    for (const d of plan.dropped) {
      lines.push(`- \`${d.sha.slice(0, 7)}\` — ${d.reason}`);
    }
    lines.push("");
  }

  if (plan.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of plan.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Apply: `atropos apply`");
  lines.push("Edit: modify the YAML block above and run `atropos apply` (it re-parses).");
  lines.push("Start over: `rm -rf .atropos/` and re-run.");
  return lines.join("\n");
}

export { BEGIN as PLAN_BEGIN, END as PLAN_END };
