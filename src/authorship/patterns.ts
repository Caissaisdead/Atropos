// Strip patterns from spec §7.5. Anchored, case-insensitive, conservative.
// False keeps are better than false strips, so patterns are tight.

export interface StripPatterns {
  trailerPatterns: RegExp[];
  footerLinePatterns: RegExp[];
  botEmailPatterns: RegExp[];
}

export const DEFAULT_STRIP: StripPatterns = {
  trailerPatterns: [
    /^Co-authored-by:.*(claude|anthropic|copilot|cursor|aider|codex|devin|github-actions).*$/i,
    /^Co-authored-by:.*\[bot\].*$/i,
    /^Co-authored-by:.*noreply@anthropic\.com.*$/i,
    /^Co-authored-by:.*\[bot\].*users\.noreply\.github\.com.*$/i,
  ],
  footerLinePatterns: [
    /^.*🤖\s*Generated with .*$/u,
    /^Generated with \[Claude Code\].*$/i,
    /^.*claude\.ai\/code.*$/i,
    /^\s*\[Claude Code\].*$/i,
  ],
  botEmailPatterns: [
    /^noreply@anthropic\.com$/i,
    /\[bot\]@users\.noreply\.github\.com$/i,
    /^.+\[bot\]@.+$/i,
  ],
};

export const DEFAULT_PRESERVE_TRAILER_KEYS = [
  "Signed-off-by",
  "Reviewed-by",
  "Tested-by",
  "Reported-by",
  "Closes",
  "Fixes",
  "Refs",
  "Resolves",
];

export function withAdditionalStripPatterns(
  base: StripPatterns,
  extras: readonly string[],
): StripPatterns {
  return {
    trailerPatterns: [...base.trailerPatterns, ...extras.map((p) => new RegExp(p, "i"))],
    footerLinePatterns: base.footerLinePatterns,
    botEmailPatterns: base.botEmailPatterns,
  };
}

export function isPreservedTrailerKey(
  key: string,
  whitelist: readonly string[] = DEFAULT_PRESERVE_TRAILER_KEYS,
): boolean {
  const lower = key.toLowerCase();
  return whitelist.some((w) => w.toLowerCase() === lower);
}
