import { gitRaw, type GitOptions } from "../git/shell.js";
import { revParse } from "../git/refs.js";
import { git } from "../git/shell.js";
import { AtroposError } from "../util/errors.js";

export function backupRefName(now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "Z");
  return `atropos/backup-${ts}`;
}

export function workRefName(now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "Z");
  return `atropos/work-${ts}`;
}

export async function createBackup(
  ref: string,
  now: Date = new Date(),
  opts: GitOptions = {},
): Promise<string> {
  const name = backupRefName(now);
  const r = await gitRaw(["branch", name, ref], opts);
  if (r.exitCode !== 0) {
    throw new AtroposError({
      code: "ERR_UNKNOWN",
      what: `failed to create backup branch ${name}`,
      why: r.stderr,
      fix: "check that the repo permits ref creation and that no colliding atropos/backup-* exists",
    });
  }
  return name;
}

export async function findLatestBackup(opts: GitOptions = {}): Promise<string | null> {
  const out = await git(
    [
      "for-each-ref",
      "--format=%(refname:short) %(creatordate:iso8601)",
      "refs/heads/atropos/backup-*",
      "--sort=-creatordate",
    ],
    opts,
  );
  if (!out.trim()) return null;
  const first = out.split("\n")[0]?.trim();
  if (!first) return null;
  return first.split(" ")[0] ?? null;
}

export async function backupExists(name: string, opts: GitOptions = {}): Promise<boolean> {
  const r = await gitRaw(["rev-parse", "--verify", `refs/heads/${name}`], opts);
  return r.exitCode === 0;
}

export async function backupTreeMatches(
  name: string,
  expected: string,
  opts: GitOptions = {},
): Promise<boolean> {
  const tree = await revParse(`${name}^{tree}`, opts);
  return tree === expected;
}
