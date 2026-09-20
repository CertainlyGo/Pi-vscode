import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { SessionSummary } from "../shared/protocol";

const HEAD_SCAN_LINES = 200;
const NAME_LIMIT = 48;

/** pi's agent dir, honouring the same env override as the CLI. */
export function getAgentDir(): string {
  const override = process.env["PI_CODING_AGENT_DIR"];
  if (override !== undefined && override.trim().length > 0) return resolve(expandHome(override.trim()));
  return join(homedir(), ".pi", "agent");
}

/**
 * `C:/Users/gg/ws` -> `--C--Users-gg-ws--`, exactly matching pi's `safePath`
 * (the colon counts as a separator too).
 */
export function workspaceSessionDir(agentDir: string, workspace: string): string {
  const resolved = resolve(workspace);
  const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const part of value) {
    const text = asRecord(part)["text"];
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join(" ");
}

function truncate(text: string, limit: number): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > limit ? `${firstLine.slice(0, limit)}…` : firstLine;
}

function extractMeta(head: readonly string[], fallbackId: string): { id: string; name: string } {
  let id = fallbackId;
  let explicitName = "";
  let firstUserText: string | undefined;
  for (const line of head) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record["type"];
    if (type === "session" || type === "session_info") {
      if (typeof record["id"] === "string" && record["id"].length > 0) id = record["id"];
      if (type === "session_info" && typeof record["name"] === "string" && record["name"].length > 0) {
        explicitName = record["name"];
        break;
      }
    }
    if (type === "message" && firstUserText === undefined) {
      const message = asRecord(record["message"]);
      if (message["role"] === "user") {
        const text = contentText(message["content"]);
        if (text.length > 0) firstUserText = truncate(text, NAME_LIMIT);
      }
    }
  }
  if (explicitName.length > 0) return { id, name: explicitName };
  if (firstUserText !== undefined && firstUserText.length > 0) return { id, name: firstUserText };
  return { id, name: id.slice(0, 8) };
}

/** List persisted sessions for a workspace, newest first. */
export async function listSessions(agentDir: string, workspace: string): Promise<SessionSummary[]> {
  const dir = workspaceSessionDir(agentDir, workspace);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".jsonl"))
      .map(async (entry): Promise<SessionSummary | undefined> => {
        const path = join(dir, entry);
        try {
          const [stats, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
          const head = raw.split("\n", HEAD_SCAN_LINES);
          const { id, name } = extractMeta(head, basename(entry, ".jsonl"));
          return { id, name, path, updatedAt: stats.mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );

  return sessions
    .filter((session): session is SessionSummary => session !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Delete a session file, refusing paths outside the workspace session dir. */
export async function deleteSession(
  agentDir: string,
  workspace: string,
  sessionPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const root = resolve(workspaceSessionDir(agentDir, workspace));
  const target = resolve(sessionPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return { ok: false, error: "refusing to delete a session outside this workspace" };
  }
  try {
    await rm(target, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}
