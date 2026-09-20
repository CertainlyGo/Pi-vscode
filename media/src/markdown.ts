import { Marked } from "marked";
import hljs from "highlight.js/lib/common";

const marked = new Marked({ gfm: true, breaks: true });

marked.use({
  renderer: {
    // Raw HTML from the model is escaped; we never trust it inside the webview.
    html({ text }) {
      return escapeHtml(text);
    },
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      // Very large blocks are escaped but not highlighted: highlightAuto is
      // linear-ish but not free, and nobody reads a 20k-line block.
      if (text.length > 20_000) {
        const className = language.length > 0 ? `hljs language-${language}` : "hljs";
        return `<pre class="code-block"><code class="${className}">${escapeHtml(text)}</code></pre>`;
      }
      let highlighted: string;
      let resolved = language;
      if (language.length > 0 && hljs.getLanguage(language) !== undefined) {
        highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } else {
        const auto = hljs.highlightAuto(text);
        highlighted = auto.value;
        resolved = auto.language ?? "";
      }
      const className = resolved.length > 0 ? `hljs language-${resolved}` : "hljs";
      return `<pre class="code-block"><code class="${className}">${highlighted}</code></pre>`;
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safeHref = sanitizeHref(href);
      if (safeHref === undefined) return label;
      const titleAttr = title !== null && title !== undefined ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noreferrer noopener">${label}</a>`;
    },
  },
});

/** Render markdown to HTML. Output is safe to inject: text and HTML are escaped. */
export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function sanitizeHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[^:]*$/.test(trimmed)) return trimmed; // relative link
  return undefined;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
