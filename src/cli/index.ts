#!/usr/bin/env node
import { Command } from "commander";
import { collectRange } from "../analyze/collect.js";
import { isAtroposError } from "../util/errors.js";
import { createLogger, type LogLevel } from "../util/logger.js";
import { applyCommand } from "./apply.js";
import { reshapeCommand } from "./reshape.js";
import { restoreCommand } from "./restore.js";
import { runDoctor } from "./doctor.js";

interface GlobalOpts {
  verbose?: boolean | number;
  debugCollect?: string | true;
}

const VERSION = "0.0.0-dev";

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("atropos")
    .description("Reshape messy agent-authored git history into clean, reviewable commits.")
    .version(VERSION)
    .option("-v, --verbose", "increase log verbosity (-vv for trace)", increaseVerbosity, 0)
    .option("--debug-collect <range>", "dump internal Commit[] JSON for the given range and exit")
    .allowExcessArguments(false);

  program
    .command("doctor")
    .description("check git binary, identity, repo cleanliness, and API key")
    .action(async () => {
      const log = makeLogger(program.opts<GlobalOpts>());
      const r = await runDoctor(log);
      process.exit(r.ok ? 0 : 10);
    });

  program
    .command("apply")
    .description("apply the on-disk plan: parse .atropos/plan.md → backup → reshape → verify → promote")
    .option("--dry-run", "print what would happen; do not mutate", false)
    .option("--allow-dirty", "allow uncommitted changes in the working tree", false)
    .option("--rewrite-pushed", "allow rewriting commits already on a remote", false)
    .option("--author <author>", "override target author, format 'Name <email>'")
    .option("--preserve-agent-attribution", "skip authorship strip (keep agent trailers/footers)", false)
    .option("--plan <path>", "load plan from a non-default path (default: .atropos/plan.md)")
    .action(async (cmdOpts: Record<string, unknown>) => {
      const logger = makeLogger(program.opts<GlobalOpts>());
      const code = await applyCommand({
        logger,
        ...(cmdOpts["dryRun"] ? { dryRun: true } : {}),
        ...(cmdOpts["allowDirty"] ? { allowDirty: true } : {}),
        ...(cmdOpts["rewritePushed"] ? { rewritePushed: true } : {}),
        ...(typeof cmdOpts["author"] === "string" ? { author: cmdOpts["author"] } : {}),
        ...(cmdOpts["preserveAgentAttribution"] ? { preserveAgentAttribution: true } : {}),
        ...(typeof cmdOpts["plan"] === "string" ? { planPath: cmdOpts["plan"] } : {}),
      });
      process.exit(code);
    });

  program
    .command("restore")
    .description("restore the current branch to the most recent atropos/backup-* ref")
    .option("--force", "skip clean-tree check", false)
    .action(async (cmdOpts: Record<string, unknown>) => {
      const logger = makeLogger(program.opts<GlobalOpts>());
      const code = await restoreCommand({
        logger,
        ...(cmdOpts["force"] ? { force: true } : {}),
      });
      process.exit(code);
    });

  program
    .argument("[range]", "explicit range, e.g. main..HEAD")
    .option("--output <path>", "write plan somewhere other than .atropos/plan.md")
    .option("--author <author>", "override target author, format 'Name <email>'")
    .option("--no-cloud", "skip the LLM; use heuristic clustering only", false)
    .action(async (range: string | undefined, cmdOpts: Record<string, unknown>) => {
      const opts = program.opts<GlobalOpts>();
      const log = makeLogger(opts);
      if (opts.debugCollect) {
        const spec = typeof opts.debugCollect === "string" ? opts.debugCollect : range;
        const result = await collectRange(spec ? { rangeSpec: spec } : {});
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      const code = await reshapeCommand({
        logger: log,
        ...(range ? { range } : {}),
        ...(typeof cmdOpts["output"] === "string" ? { output: cmdOpts["output"] } : {}),
        ...(typeof cmdOpts["author"] === "string" ? { author: cmdOpts["author"] } : {}),
        ...(cmdOpts["cloud"] === false ? { noCloud: true } : {}),
      });
      process.exit(code);
    });

  installSignalHandlers();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    handleError(err);
  }
}

function increaseVerbosity(_value: string, previous: number): number {
  return previous + 1;
}

function makeLogger(opts: GlobalOpts) {
  const v = typeof opts.verbose === "number" ? opts.verbose : opts.verbose ? 1 : 0;
  const level: LogLevel = v >= 2 ? "trace" : v === 1 ? "debug" : "info";
  return createLogger({ level });
}

function handleError(err: unknown): never {
  if (isAtroposError(err)) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `error: ERR_UNKNOWN: unexpected failure — ${msg} — re-run with -v for more detail or report at https://github.com/Caissaisdead/Atropos/issues\n`,
  );
  if (err instanceof Error && err.stack && process.env["ATROPOS_DEBUG"]) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
}

function installSignalHandlers(): void {
  const onSignal = (sig: NodeJS.Signals) => {
    process.stderr.write(`\nreceived ${sig} — exiting\n`);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

const isMain =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].replace(/^.*\//, "")));

if (isMain) {
  main().catch(handleError);
}
