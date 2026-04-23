import kleur from "kleur";
import { gitRaw } from "../git/shell.js";
import { gitDir } from "../git/guards.js";
import type { Logger } from "../util/logger.js";

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function runDoctor(logger: Logger): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const ver = await gitRaw(["--version"]);
  if (ver.exitCode === 0) {
    const v = ver.stdout.trim().replace(/^git version /, "");
    checks.push({ name: "git binary", status: "ok", detail: v });
  } else {
    checks.push({ name: "git binary", status: "fail", detail: "git not on PATH" });
  }

  const inRepo = await gitRaw(["rev-parse", "--git-dir"]);
  if (inRepo.exitCode === 0) {
    let dir: string;
    try {
      dir = await gitDir();
    } catch {
      dir = inRepo.stdout.trim();
    }
    checks.push({ name: "in git repo", status: "ok", detail: dir });

    const status = await gitRaw(["status", "--porcelain"]);
    if (status.exitCode === 0) {
      if (status.stdout.trim().length === 0) {
        checks.push({ name: "working tree clean", status: "ok", detail: "no uncommitted changes" });
      } else {
        const n = status.stdout.trim().split("\n").length;
        checks.push({
          name: "working tree clean",
          status: "warn",
          detail: `${n} uncommitted change${n === 1 ? "" : "s"} (apply will refuse without --allow-dirty)`,
        });
      }
    }
  } else {
    checks.push({
      name: "in git repo",
      status: "fail",
      detail: "run atropos inside a git repository",
    });
  }

  const name = await gitRaw(["config", "user.name"]);
  const email = await gitRaw(["config", "user.email"]);
  const haveName = name.exitCode === 0 && name.stdout.trim().length > 0;
  const haveEmail = email.exitCode === 0 && email.stdout.trim().length > 0;
  if (haveName && haveEmail) {
    checks.push({
      name: "git identity",
      status: "ok",
      detail: `${name.stdout.trim()} <${email.stdout.trim()}>`,
    });
  } else {
    checks.push({
      name: "git identity",
      status: "fail",
      detail: "set user.name and user.email, or pass --author at run time",
    });
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey && apiKey.length > 0) {
    checks.push({
      name: "ANTHROPIC_API_KEY",
      status: "ok",
      detail: `present (${apiKey.length} chars)`,
    });
  } else {
    checks.push({
      name: "ANTHROPIC_API_KEY",
      status: "warn",
      detail: "not set — atropos will fall back to heuristic clustering",
    });
  }

  const ok = checks.every((c) => c.status !== "fail");
  printReport(checks, logger);
  return { ok, checks };
}

function printReport(checks: DoctorCheck[], logger: Logger): void {
  const colorize = process.stderr.isTTY;
  for (const c of checks) {
    const tag =
      c.status === "ok"
        ? colorize ? kleur.green("✓") : "[ok]  "
        : c.status === "warn"
          ? colorize ? kleur.yellow("!") : "[warn]"
          : colorize ? kleur.red("✗") : "[fail]";
    logger.info(`${tag} ${c.name}: ${c.detail}`);
  }
}
