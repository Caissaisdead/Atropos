import { execa, type Options as ExecaOptions, ExecaError } from "execa";
import { AtroposError } from "../util/errors.js";
import { log as defaultLog, type Logger } from "../util/logger.js";

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function git(args: readonly string[], opts: GitOptions = {}): Promise<string> {
  const r = await gitRaw(args, opts);
  if (r.exitCode !== 0) {
    throw mapGitError(args, r);
  }
  return r.stdout;
}

export async function gitRaw(
  args: readonly string[],
  opts: GitOptions = {},
): Promise<GitResult> {
  const logger = opts.logger ?? defaultLog;
  const t0 = Date.now();
  const execOpts: ExecaOptions = {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    reject: false,
    encoding: "utf8",
    stripFinalNewline: true,
  };

  try {
    const result = await execa("git", args as string[], execOpts);
    const dt = Date.now() - t0;
    logger.debug(`git ${args.join(" ")} (${dt}ms exit=${result.exitCode ?? 0})`);
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: result.exitCode ?? 0,
    };
  } catch (err) {
    const dt = Date.now() - t0;
    if (err instanceof ExecaError) {
      logger.debug(`git ${args.join(" ")} (${dt}ms FAILED: ${err.shortMessage})`);
      throw new AtroposError({
        code: "ERR_UNKNOWN",
        what: `git invocation failed: ${args.join(" ")}`,
        why: err.shortMessage,
        fix: "re-run with `-v` for the full git argv and exit code",
        cause: err,
      });
    }
    throw err;
  }
}

function mapGitError(args: readonly string[], r: GitResult): AtroposError {
  const stderr = r.stderr.trim();

  if (/not a git repository/i.test(stderr)) {
    return new AtroposError({
      code: "ERR_NOT_A_REPO",
      what: "not a git repository",
      fix: "run atropos inside a repo",
    });
  }

  if (/unknown revision|bad revision|ambiguous argument/i.test(stderr)) {
    return new AtroposError({
      code: "ERR_BAD_RANGE",
      what: `git rejected the range or revision: ${args.join(" ")}`,
      why: stderr,
      fix: "try `atropos main..HEAD` or pass an explicit range",
    });
  }

  return new AtroposError({
    code: "ERR_UNKNOWN",
    what: `git ${args.join(" ")} exited ${r.exitCode}`,
    why: stderr || "(no stderr)",
  });
}
