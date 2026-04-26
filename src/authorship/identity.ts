import { loadAtroposConfig } from "../config/load.js";
import { gitRaw, type GitOptions } from "../git/shell.js";
import type { Identity } from "../git/types.js";
import { AtroposError } from "../util/errors.js";

const AUTHOR_RE = /^\s*(.+?)\s*<\s*([^<>]+?)\s*>\s*$/;

export interface ResolveIdentityOptions {
  authorFlag?: string;
  configPath?: string;
  cwd?: string;
  gitOptions?: GitOptions;
}

export async function resolveTargetIdentity(
  opts: ResolveIdentityOptions = {},
): Promise<Identity> {
  if (opts.authorFlag) {
    const id = parseAuthor(opts.authorFlag);
    if (!id) {
      throw new AtroposError({
        code: "ERR_NO_IDENTITY",
        what: `--author '${opts.authorFlag}' is not in 'Name <email>' form`,
        fix: "use --author 'Sid Nigam <sid@example.com>'",
      });
    }
    return id;
  }

  const fromConfig = await readAtroposJsonAuthor(opts.cwd);
  if (fromConfig) return fromConfig;

  const gitOpts: GitOptions = opts.gitOptions ?? (opts.cwd ? { cwd: opts.cwd } : {});
  const fromGit = await readGitConfigIdentity(gitOpts);
  if (fromGit) return fromGit;

  throw new AtroposError({
    code: "ERR_NO_IDENTITY",
    what: "no author found",
    fix: "set `user.email` and `user.name` in git or pass `--author`",
  });
}

export function parseAuthor(s: string): Identity | null {
  const m = AUTHOR_RE.exec(s);
  if (!m) return null;
  return { name: m[1] ?? "", email: m[2] ?? "" };
}

async function readAtroposJsonAuthor(cwd?: string): Promise<Identity | null> {
  const cfg = await loadAtroposConfig(cwd ? { cwd } : {});
  const author = cfg?.authorship?.author;
  if (!author) return null;
  return parseAuthor(author);
}

async function readGitConfigIdentity(opts: GitOptions): Promise<Identity | null> {
  const name = await gitRaw(["config", "user.name"], opts);
  const email = await gitRaw(["config", "user.email"], opts);
  if (name.exitCode !== 0 || email.exitCode !== 0) return null;
  const n = name.stdout.trim();
  const e = email.stdout.trim();
  if (!n || !e) return null;
  return { name: n, email: e };
}
