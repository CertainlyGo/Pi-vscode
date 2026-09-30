/**
 * Shared display formatting for the webview.
 *
 * Kept out of the components so the usage bar and the compaction notes agree on
 * how token counts are rendered.
 */

/** Compact a token count: `1234 -> 1.2k`, `2_500_000 -> 2.5M`. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}
