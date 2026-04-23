import type { PlanDocument } from "../cluster/schema.js";
import { revParse } from "../git/refs.js";
import type { GitOptions } from "../git/shell.js";
import type { Sha } from "../git/types.js";
import { AtroposError } from "../util/errors.js";

export interface ValidatePlanFreshnessOptions extends GitOptions {
  rangeShas?: Iterable<Sha>;
}

export async function assertPlanIsFresh(
  plan: PlanDocument,
  opts: ValidatePlanFreshnessOptions = {},
): Promise<void> {
  const headSha = await revParse(plan.range.headRef, opts);
  if (!shaPrefixMatches(headSha, plan.range.head)) {
    throw new AtroposError({
      code: "ERR_PLAN_PARSE",
      what: `plan range.head (${plan.range.head}) does not match current ${plan.range.headRef} tip (${headSha})`,
      why: "HEAD has moved since the plan was generated",
      fix: "regenerate the plan, then re-run apply",
    });
  }
  if (opts.rangeShas) {
    const inRange = new Set<string>(Array.from(opts.rangeShas, (s) => String(s)));
    for (const c of plan.clusters) {
      for (const m of c.memberShas) {
        if (!isMemberInRange(m, inRange)) {
          throw new AtroposError({
            code: "ERR_PLAN_PARSE",
            what: `cluster ${c.id} references sha ${m} that is not in the range`,
            fix: "remove or replace the offending memberShas entry",
          });
        }
      }
    }
  }
}

function shaPrefixMatches(a: string, b: string): boolean {
  const min = Math.min(a.length, b.length);
  if (min < 7) return false;
  return a.slice(0, min) === b.slice(0, min);
}

function isMemberInRange(member: string, range: Set<string>): boolean {
  if (range.has(member)) return true;
  for (const r of range) {
    if (shaPrefixMatches(member, r)) return true;
  }
  return false;
}
