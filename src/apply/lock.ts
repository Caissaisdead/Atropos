import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { gitDir } from "../git/guards.js";
import type { GitOptions } from "../git/shell.js";
import { AtroposError } from "../util/errors.js";

const LOCK_NAME = "atropos.lock";
const STALE_AFTER_MS = 30 * 60 * 1000;

export interface LockHandle {
  path: string;
  release(): void;
}

export async function acquireLock(opts: GitOptions = {}): Promise<LockHandle> {
  const dir = await gitDir(opts);
  const cwd = opts.cwd ?? process.cwd();
  const fullDir = dir.startsWith("/") ? dir : join(cwd, dir);
  const path = join(fullDir, LOCK_NAME);

  if (existsSync(path)) {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    const contents = safeRead(path);
    if (ageMs < STALE_AFTER_MS) {
      throw new AtroposError({
        code: "ERR_LOCKED",
        what: `${path} is held`,
        why: contents
          ? `another atropos run in progress (${contents})`
          : "another atropos run is in progress",
        fix: "wait for it to finish, or delete the lock if you're sure no run is active",
      });
    }
    throw new AtroposError({
      code: "ERR_LOCKED",
      what: `${path} is stale (>${Math.round(STALE_AFTER_MS / 60000)} min old)`,
      why: contents ? `recovered owner info: ${contents}` : "owner unknown",
      fix: `delete ${path} to recover, then re-run`,
    });
  }

  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err) {
    throw new AtroposError({
      code: "ERR_LOCKED",
      what: `failed to acquire ${path}`,
      why: err instanceof Error ? err.message : String(err),
      fix: "retry; if this persists, remove the lock file manually",
    });
  }

  const owner = `pid=${process.pid} host=${process.env["HOSTNAME"] ?? "?"} ts=${new Date().toISOString()}`;
  writeSync(fd, owner);
  closeSync(fd);

  return {
    path,
    release(): void {
      try {
        if (existsSync(path)) rmSync(path);
      } catch {
        // best-effort
      }
    },
  };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
