import { revParse } from "../git/refs.js";
import type { GitOptions } from "../git/shell.js";
import type { Sha } from "../git/types.js";
import { AtroposError } from "../util/errors.js";

export interface VerifyResult {
  originalTree: Sha;
  newTree: Sha;
}

export async function verifyTreeEquality(
  originalRef: string,
  newRef: string,
  opts: GitOptions = {},
): Promise<VerifyResult> {
  const originalTree = await revParse(`${originalRef}^{tree}`, opts);
  const newTree = await revParse(`${newRef}^{tree}`, opts);
  if (originalTree !== newTree) {
    throw new AtroposError({
      code: "ERR_TREE_MISMATCH",
      what: "reshaped tree does not match original tree",
      why: `expected ${originalTree}, got ${newTree}`,
      fix: "atropos restore   # then investigate the source commits",
    });
  }
  return { originalTree, newTree };
}
