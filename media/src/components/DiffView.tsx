import type { JSX } from "react";
import { useMemo } from "react";

type RowKind = "file" | "hunk" | "add" | "del" | "ctx" | "meta";

interface DiffRow {
  readonly kind: RowKind;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

interface ParsedDiff {
  readonly rows: readonly DiffRow[];
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Parse a diff produced by pi. Two shapes are supported:
 *  - a standard unified diff (pi's `details.patch`), and
 *  - pi's display-oriented diff (`details.diff`): `+ 12 line`, `- 10 line`,
 *    `  11 line` with right-aligned line numbers and `...` gap markers.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  return text.includes("@@") ? parseHunkDiff(text) : parseDisplayDiff(text);
}

function parseHunkDiff(text: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split("\n")) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ")
    ) {
      rows.push({ kind: "file", text: raw, oldLine: null, newLine: null });
      inHunk = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = match === null ? 0 : Number(match[1]);
      newLine = match === null ? 0 : Number(match[2]);
      rows.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine: newLine++ });
      additions += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++, newLine: null });
      deletions += 1;
      continue;
    }
    if (raw.startsWith("\\")) {
      rows.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
      continue;
    }
    rows.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldLine: oldLine++, newLine: newLine++ });
  }

  return { rows, additions, deletions };
}

function parseDisplayDiff(text: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  for (const raw of text.split("\n")) {
    const match = /^([+\- ])(\s*\d*)\s(.*)$/.exec(raw);
    if (match === null) {
      if (raw.trim().length > 0) rows.push({ kind: "ctx", text: raw, oldLine: null, newLine: null });
      continue;
    }
    const sign = match[1] ?? " ";
    const digits = (match[2] ?? "").trim();
    const content = match[3] ?? "";
    const line = digits.length > 0 ? Number(digits) : null;
    if (sign === "+") {
      rows.push({ kind: "add", text: content, oldLine: null, newLine: line });
      additions += 1;
    } else if (sign === "-") {
      rows.push({ kind: "del", text: content, oldLine: line, newLine: null });
      deletions += 1;
    } else {
      rows.push({ kind: "ctx", text: content, oldLine: line, newLine: line });
    }
  }
  return { rows, additions, deletions };
}

interface DiffViewProps {
  readonly diff: string;
  readonly maxRows?: number;
}

export function DiffView({ diff, maxRows = 400 }: DiffViewProps): JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const rows = parsed.rows.length > maxRows ? parsed.rows.slice(0, maxRows) : parsed.rows;

  return (
    <div className="diff">
      <div className="diff-summary">
        <span className="diff-add">+{parsed.additions}</span>
        <span className="diff-del">-{parsed.deletions}</span>
      </div>
      <div className="diff-body">
        {rows.map((row, index) => (
          <div key={index} className={`diff-row ${row.kind}`}>
            <span className="diff-gutter">{row.oldLine ?? ""}</span>
            <span className="diff-gutter">{row.newLine ?? ""}</span>
            <span className="diff-sign">
              {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
            </span>
            <span className="diff-text">{row.text}</span>
          </div>
        ))}
        {parsed.rows.length > maxRows && (
          <div className="diff-more">… {parsed.rows.length - maxRows} more lines</div>
        )}
      </div>
    </div>
  );
}
