export type ErrorCode =
  | "ERR_NOT_A_REPO"
  | "ERR_BAD_RANGE"
  | "ERR_NO_IDENTITY"
  | "ERR_NO_API_KEY"
  | "ERR_LLM_INVALID"
  | "ERR_PUSHED"
  | "ERR_DIRTY"
  | "ERR_LOCKED"
  | "ERR_CONFLICT"
  | "ERR_TREE_MISMATCH"
  | "ERR_UNSUPPORTED"
  | "ERR_PLAN_PARSE"
  | "ERR_INTERRUPTED"
  | "ERR_USAGE"
  | "ERR_UNKNOWN";

const EXIT_CODES: Record<ErrorCode, number> = {
  ERR_USAGE: 2,
  ERR_NOT_A_REPO: 2,
  ERR_BAD_RANGE: 2,
  ERR_NO_IDENTITY: 10,
  ERR_NO_API_KEY: 10,
  ERR_LLM_INVALID: 21,
  ERR_PUSHED: 31,
  ERR_DIRTY: 31,
  ERR_UNSUPPORTED: 31,
  ERR_PLAN_PARSE: 30,
  ERR_LOCKED: 40,
  ERR_CONFLICT: 32,
  ERR_TREE_MISMATCH: 33,
  ERR_INTERRUPTED: 130,
  ERR_UNKNOWN: 1,
};

export interface AtroposErrorInit {
  code: ErrorCode;
  what: string;
  why?: string;
  fix?: string;
  cause?: unknown;
}

export class AtroposError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly what: string;
  readonly why?: string;
  readonly fix?: string;

  constructor(init: AtroposErrorInit) {
    const msg = formatMessage(init);
    super(msg, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "AtroposError";
    this.code = init.code;
    this.exitCode = EXIT_CODES[init.code];
    this.what = init.what;
    if (init.why !== undefined) this.why = init.why;
    if (init.fix !== undefined) this.fix = init.fix;
  }
}

function formatMessage(init: AtroposErrorInit): string {
  const parts = [`${init.code}: ${init.what}`];
  if (init.why) parts.push(init.why);
  if (init.fix) parts.push(init.fix);
  return parts.join(" — ");
}

export function isAtroposError(err: unknown): err is AtroposError {
  return err instanceof AtroposError;
}
