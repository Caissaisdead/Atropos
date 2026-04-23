// Rough estimator: whitespace-split count × 1.3. Good enough for budgeting
// against the 200k-token Sonnet context window without pulling in tiktoken.

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const wordish = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(wordish * 1.3);
}

export const TOKEN_LIMIT_HARD = 150_000;
export const PER_COMMIT_DIFF_LINE_CAP = 400;
export const PER_RANGE_DIFF_LINE_CAP = 6_000;
