import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { ToolItem } from "../../../src/shared/protocol";
import { DiffView } from "./DiffView";
import { Icon } from "./Icons";
import type { IconName } from "./Icons";

export interface ToolCardProps {
  readonly item: ToolItem;
  readonly onOpenFile: (path: string, line?: number) => void;
  readonly onOpenDiff: (id: string) => void;
}

interface ToolMeta {
  readonly icon: IconName;
  readonly label: string;
  readonly target: string;
  readonly detail?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? text;
}

function toolMeta(item: ToolItem): ToolMeta {
  const args = item.args;
  switch (item.name) {
    case "bash":
    case "powershell": {
      const command = asString(args["command"]) ?? "";
      return { icon: "terminal", label: item.name === "bash" ? "Run" : "PowerShell", target: firstLine(command) };
    }
    case "read": {
      const path = asString(args["path"]) ?? "";
      const offset = typeof args["offset"] === "number" ? args["offset"] : undefined;
      const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
      const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit}` : ""}` : "";
      return { icon: "file", label: "Read", target: `${path}${range}` };
    }
    case "edit":
      return { icon: "edit", label: "Edit", target: asString(args["path"]) ?? "" };
    case "write":
      return { icon: "edit", label: "Write", target: asString(args["path"]) ?? "" };
    case "grep": {
      const pattern = asString(args["pattern"]) ?? "";
      const path = asString(args["path"]);
      return { icon: "search", label: "Grep", target: `/${pattern}/${path !== undefined ? ` in ${path}` : ""}` };
    }
    case "find":
      return { icon: "search", label: "Find", target: asString(args["pattern"]) ?? "" };
    case "ls":
      return { icon: "folder", label: "List", target: asString(args["path"]) ?? "." };
    default:
      return { icon: "chip", label: item.name, target: "" };
  }
}

/** Build a display diff for `write` calls, which have no diff in their result. */
function writeDiff(item: ToolItem): string | undefined {
  if (item.diff !== undefined) return item.diff;
  const path = asString(item.args["path"]);
  const content = asString(item.args["content"]);
  if (path === undefined || content === undefined) return undefined;
  const lines = content.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
}

export function ToolCard({ item, onOpenFile, onOpenDiff }: ToolCardProps): JSX.Element {
  const meta = useMemo(() => toolMeta(item), [item]);
  const diff = item.name === "write" ? writeDiff(item) : item.diff;
  const [expanded, setExpanded] = useState(
    item.status === "error" || item.status === "running" || item.name === "bash",
  );
  const path = item.filePath ?? asString(item.args["path"]);
  const duration =
    item.endedAt !== undefined ? Math.max(0, item.endedAt - item.startedAt) : undefined;

  return (
    <div className={`tool tool-${item.status}`}>
      <button className="tool-head" type="button" onClick={() => setExpanded((value) => !value)}>
        <span className={`tool-status ${item.status}`}>
          <Icon name={item.status === "running" ? "spinner" : item.status === "error" ? "error" : "check"} size={13} />
        </span>
        <span className="tool-icon">
          <Icon name={meta.icon} size={14} />
        </span>
        <span className="tool-label">{meta.label}</span>
        <span className="tool-target" title={meta.target}>
          {meta.target || (item.argsText !== undefined && item.argsText.length > 0 ? item.argsText : "")}
        </span>
        <span className="tool-spacer" />
        {duration !== undefined && <span className="tool-duration">{formatDuration(duration)}</span>}
        <span className="tool-chevron">
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
        </span>
      </button>

      {expanded && (
        <div className="tool-body">
          {diff !== undefined && <DiffView diff={diff} />}
          {diff === undefined && item.output.length > 0 && <pre className="tool-output">{item.output}</pre>}
          {diff === undefined && item.output.length === 0 && item.argsText !== undefined && item.argsText.length > 0 && (
            <pre className="tool-output">{item.argsText}</pre>
          )}
          {diff === undefined && item.output.length === 0 && (item.argsText === undefined || item.argsText.length === 0) && item.name !== "bash" && (
            <pre className="tool-output">{prettyJson(item.args)}</pre>
          )}
          <div className="tool-actions">
            {diff !== undefined && (
              <button type="button" className="link-btn" onClick={() => onOpenDiff(item.id)}>
                Open diff
              </button>
            )}
            {path !== undefined && path.length > 0 && (
              <button type="button" className="link-btn" onClick={() => onOpenFile(path, item.line)}>
                Open file
              </button>
            )}
            {item.fullOutputPath !== undefined && (
              <button type="button" className="link-btn" onClick={() => onOpenFile(item.fullOutputPath ?? "")}>
                Full output
              </button>
            )}
            {item.truncated === true && <span className="tool-truncated">output truncated</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function prettyJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(millis: number): string {
  if (millis < 1000) return `${millis}ms`;
  const seconds = millis / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
