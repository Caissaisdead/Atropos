import kleur from "kleur";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]{20,}/g;

export interface Logger {
  level: LogLevel;
  error(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  debug(msg: string, ...rest: unknown[]): void;
  trace(msg: string, ...rest: unknown[]): void;
  child(prefix: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  color?: boolean;
  stream?: NodeJS.WritableStream;
  prefix?: string;
}

export function redact(input: string): string {
  return input.replace(ANTHROPIC_KEY_RE, "sk-ant-***");
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const stream = opts.stream ?? process.stderr;
  const useColor = opts.color ?? (stream === process.stderr && Boolean(process.stderr.isTTY));
  const k = useColor ? kleur : kleur.enabled ? noColorKleur() : kleur;
  const prefix = opts.prefix ?? "";
  let level: LogLevel = opts.level ?? "info";

  function emit(lvl: LogLevel, tag: string, msg: string, rest: unknown[]): void {
    if (LEVEL_RANK[lvl] > LEVEL_RANK[level]) return;
    const safeMsg = redact(msg);
    const restStr = rest.length
      ? " " + rest.map((r) => redact(typeof r === "string" ? r : safeStringify(r))).join(" ")
      : "";
    stream.write(`${tag} ${prefix}${safeMsg}${restStr}\n`);
  }

  return {
    get level() {
      return level;
    },
    set level(l: LogLevel) {
      level = l;
    },
    error(msg, ...rest) {
      emit("error", useColor ? k.red("✗") : "ERROR", msg, rest);
    },
    warn(msg, ...rest) {
      emit("warn", useColor ? k.yellow("!") : "WARN ", msg, rest);
    },
    info(msg, ...rest) {
      emit("info", useColor ? k.cyan("·") : "INFO ", msg, rest);
    },
    debug(msg, ...rest) {
      emit("debug", useColor ? k.gray("›") : "DEBUG", msg, rest);
    },
    trace(msg, ...rest) {
      emit("trace", useColor ? k.gray("»") : "TRACE", msg, rest);
    },
    child(p: string) {
      return createLogger({ ...opts, prefix: prefix + p + " " });
    },
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function noColorKleur() {
  // kleur is already a singleton; this is a placeholder for the type narrowing above.
  return kleur;
}

export const log = createLogger();
