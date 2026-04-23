import { git, type GitOptions } from "../git/shell.js";
import { parseRawAndNumstat } from "../git/commits.js";
import type { FileChange, Range } from "../git/types.js";

export interface NetDiffArea {
  topDir: string;
  added: number;
  deleted: number;
  files: number;
}

export interface NetDiffReport {
  filesChanged: number;
  added: number;
  deleted: number;
  files: FileChange[];
  areas: NetDiffArea[];
}

export async function netDiff(range: Range, opts: GitOptions = {}): Promise<NetDiffReport> {
  const raw = await git(
    ["diff", "--raw", "--numstat", "-M", `${range.base}..${range.head}`],
    opts,
  );
  const files = parseRawAndNumstat(raw);

  let added = 0;
  let deleted = 0;
  const byArea = new Map<string, NetDiffArea>();
  for (const f of files) {
    added += f.added;
    deleted += f.deleted;
    const top = topDir(f.path);
    const area = byArea.get(top) ?? { topDir: top, added: 0, deleted: 0, files: 0 };
    area.added += f.added;
    area.deleted += f.deleted;
    area.files += 1;
    byArea.set(top, area);
  }

  const areas = Array.from(byArea.values()).sort(
    (a, b) => b.added + b.deleted - (a.added + a.deleted),
  );

  return { filesChanged: files.length, added, deleted, files, areas };
}

export function topDir(path: string): string {
  const idx = path.indexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

export function longestCommonDir(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) {
    const p = paths[0]!;
    const idx = p.lastIndexOf("/");
    return idx === -1 ? "" : p.slice(0, idx);
  }
  const split = paths.map((p) => p.split("/"));
  const minLen = Math.min(...split.map((s) => s.length));
  const out: string[] = [];
  for (let i = 0; i < minLen - 1; i++) {
    const seg = split[0]![i]!;
    if (split.every((s) => s[i] === seg)) out.push(seg);
    else break;
  }
  return out.join("/");
}
