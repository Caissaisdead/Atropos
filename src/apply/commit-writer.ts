import { git, type GitOptions } from "../git/shell.js";
import type { Commit, Identity, Trailer } from "../git/types.js";
import type { PlannedCluster } from "./types.js";

export interface ComposeInput {
  cluster: PlannedCluster;
  members: Commit[];
  preserveTrailers: Trailer[];
}

export function composeMessage(input: ComposeInput): string {
  const { cluster, preserveTrailers } = input;
  const subject = cluster.scope
    ? `${cluster.type}(${cluster.scope}): ${cluster.subject}`
    : `${cluster.type}: ${cluster.subject}`;

  const sections: string[] = [subject];
  if (cluster.body && cluster.body.trim().length > 0) {
    sections.push(cluster.body.trim());
  }
  if (preserveTrailers.length > 0) {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const t of preserveTrailers) {
      const key = `${t.key}:${t.value}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(t.raw);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n") + "\n";
}

export function earliestAuthoredAt(members: readonly Commit[]): string {
  if (members.length === 0) return new Date().toISOString();
  let earliest = members[0]!.authoredAt;
  for (let i = 1; i < members.length; i++) {
    const candidate = members[i]!.authoredAt;
    if (candidate < earliest) earliest = candidate;
  }
  return earliest;
}

export interface CommitWriterInput {
  message: string;
  author: Identity;
  authorDate: string;
  committer: Identity;
  committerDate?: string;
  cwd?: string;
  allowEmpty?: boolean;
}

export async function writeCommit(
  input: CommitWriterInput,
  opts: GitOptions = {},
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_AUTHOR_DATE: input.authorDate,
    GIT_COMMITTER_NAME: input.committer.name,
    GIT_COMMITTER_EMAIL: input.committer.email,
    GIT_COMMITTER_DATE: input.committerDate ?? new Date().toISOString(),
  };
  const args = ["commit", "--no-verify", "--no-gpg-sign", "-m", input.message];
  if (input.allowEmpty) args.push("--allow-empty");
  await git(args, { ...opts, env, cwd: input.cwd ?? opts.cwd });
}
