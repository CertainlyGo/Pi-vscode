/**
 * Tiny text helpers shared by the extension host and the webview. Keep this
 * file dependency-free so both bundles can import it.
 */

/** First line of a possibly multi-line string (`""` stays `""`). */
export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? text;
}
