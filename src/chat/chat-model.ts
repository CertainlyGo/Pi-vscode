import type {
  Attachment,
  BashItem,
  ChatItem,
  CompactionItem,
  HostMessage,
  Meta,
  ModelInfo,
  NoteLevel,
  ToolItem,
  UsageStats,
} from "../shared/protocol";
import { EMPTY_META } from "../shared/protocol";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record["type"] === "text" && typeof record["text"] === "string") parts.push(record["text"]);
  }
  return parts.join("");
}

function contentThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record["type"] === "thinking" && typeof record["thinking"] === "string") {
      parts.push(record["thinking"]);
    }
  }
  return parts.join("");
}

function contentAttachments(content: unknown): Attachment[] {
  if (!Array.isArray(content)) return [];
  const attachments: Attachment[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record["type"] === "image" && typeof record["data"] === "string") {
      attachments.push({
        kind: "image",
        path: "",
        label: "image",
        text: record["data"],
        ...(str(record["mimeType"]) !== undefined ? { mimeType: str(record["mimeType"]) } : {}),
      });
    }
  }
  return attachments;
}

/** Running token/cost counters for one assistant message. */
export interface UsageCounters {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

const ZERO_COUNTERS: UsageCounters = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function addCounters(a: UsageCounters, b: UsageCounters): UsageCounters {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

function hasUsage(counters: UsageCounters): boolean {
  return (
    counters.input > 0 ||
    counters.output > 0 ||
    counters.cacheRead > 0 ||
    counters.cacheWrite > 0 ||
    counters.cost > 0
  );
}

function sameCounters(a: UsageCounters, b: UsageCounters): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.cost === b.cost
  );
}

/** Read a raw provider `Usage` payload (streaming updates, `message_end`). */
export function parseMessageUsage(usage: unknown): UsageCounters | null {
  const record = asRecord(usage);
  const input = num(record["input"]);
  const output = num(record["output"]);
  if (input === undefined && output === undefined) return null;
  const cost = asRecord(record["cost"]);
  const costTotal = num(cost["total"]);
  const costSum =
    (num(cost["input"]) ?? 0) +
    (num(cost["output"]) ?? 0) +
    (num(cost["cacheRead"]) ?? 0) +
    (num(cost["cacheWrite"]) ?? 0);
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(record["cacheRead"]) ?? 0,
    cacheWrite: num(record["cacheWrite"]) ?? 0,
    cost: costTotal ?? costSum,
  };
}

export interface ToolContent {
  readonly text: string;
  readonly diff?: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly truncated?: boolean;
  readonly fullOutputPath?: string;
}

/** Pull display data out of a tool result (content blocks + `details`). */
export function readToolResult(result: unknown, args: Record<string, unknown>): ToolContent {
  const record = asRecord(result);
  const details = asRecord(record["details"]);
  const text = contentText(record["content"]);
  // `patch` is a standard unified diff; `diff` is pi's display-oriented variant.
  const diff = str(details["patch"]) ?? str(details["diff"]);
  const filePath =
    str(details["filePath"]) ?? str(details["path"]) ?? str(args["path"]) ?? str(args["file_path"]);
  const line = num(details["firstChangedLine"]);
  const truncation = asRecord(details["truncation"]);
  const truncated =
    Object.keys(truncation).length > 0 ? truncation["truncated"] !== false : undefined;
  const fullOutputPath = str(details["fullOutputPath"]);
  return {
    text,
    ...(diff !== undefined ? { diff } : {}),
    ...(filePath !== undefined ? { filePath } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
  };
}

/** Map `get_session_stats` data into the compact shape the webview renders. */
export function toUsageStats(data: Record<string, unknown> | undefined): UsageStats | null {
  if (data === undefined) return null;
  const tokens = asRecord(data["tokens"]);
  const context = asRecord(data["contextUsage"]);
  const input = num(tokens["input"]) ?? 0;
  const output = num(tokens["output"]) ?? 0;
  const cacheRead = num(tokens["cacheRead"]) ?? 0;
  const cacheWrite = num(tokens["cacheWrite"]) ?? 0;
  const totalTokens = num(tokens["total"]) ?? input + output + cacheRead + cacheWrite;
  const cost = num(data["cost"]) ?? 0;
  const contextTokens = num(context["tokens"]) ?? undefined;
  const contextWindow = num(context["contextWindow"]) ?? undefined;
  const contextPercent = num(context["percent"]) ?? undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextPercent !== undefined ? { contextPercent } : {}),
  };
}

/** Map a pi `Model` object into the webview's {@link ModelInfo}. */
export function toModelInfo(model: unknown): ModelInfo | null {
  const record = asRecord(model);
  const id = str(record["id"]);
  const provider = str(record["provider"]);
  if (id === undefined || provider === undefined) return null;
  const cost = asRecord(record["cost"]);
  return {
    id,
    provider,
    name: str(record["name"]) ?? id,
    ...(record["reasoning"] === true ? { reasoning: true } : {}),
    ...(num(record["contextWindow"]) !== undefined ? { contextWindow: num(record["contextWindow"]) } : {}),
    cost: {
      input: num(cost["input"]) ?? 0,
      output: num(cost["output"]) ?? 0,
      cacheRead: num(cost["cacheRead"]) ?? 0,
      cacheWrite: num(cost["cacheWrite"]) ?? 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* ChatModel                                                           */
/* ------------------------------------------------------------------ */

export interface ChatModelOptions {
  readonly emit: (message: HostMessage) => void;
}

/**
 * Consumes pi's RPC event stream and produces the ordered list of chat items
 * plus the session metadata the webview renders. All state is kept here so a
 * webview reload can be served a fresh full snapshot.
 */
export class ChatModel {
  readonly #emit: (message: HostMessage) => void;
  #items: ChatItem[] = [];
  #meta: Meta = EMPTY_META;
  #counter = 0;
  #assistantId: string | null = null;
  #lastToolCallId: string | null = null;
  /** Session totals as reported by `get_session_stats`. */
  #baseStats: UsageStats | null = null;
  /** Usage of finished messages of the in-flight turn, not yet in `#baseStats`. */
  #committedUsage: UsageCounters = ZERO_COUNTERS;
  /** Cumulative usage reported for the message currently streaming. */
  #streamingUsage: UsageCounters = ZERO_COUNTERS;
  /** Prompt tokens of the most recent message, used to estimate context live. */
  #lastPromptTokens = 0;
  readonly #toolItemByCallId = new Map<string, string>();
  /** pi request id -> bash item id, for `bash_execution_update` events. */
  readonly #bashItemByRequestId = new Map<string, string>();
  /** User messages we rendered optimistically, awaiting pi's echo. */
  readonly #pendingUserEcho: string[] = [];

  constructor(options: ChatModelOptions) {
    this.#emit = options.emit;
  }

  get items(): readonly ChatItem[] {
    return this.#items;
  }

  findItem(id: string): ChatItem | undefined {
    return this.#items.find((item) => item.id === id);
  }

  get meta(): Meta {
    return this.#meta;
  }

  setShowThinking(show: boolean): void {
    this.setMeta({ showThinking: show });
  }

  /**
   * Install the authoritative session totals. Any live counters are dropped
   * because the fresh snapshot already includes every completed message.
   */
  setStats(stats: UsageStats | null): void {
    this.#baseStats = stats;
    this.#committedUsage = ZERO_COUNTERS;
    this.#streamingUsage = ZERO_COUNTERS;
    this.#lastPromptTokens = 0;
    this.#emitStats();
  }

  setMeta(patch: Partial<Meta>): void {
    this.#meta = { ...this.#meta, ...patch };
    this.#emit({ type: "meta", meta: this.#meta });
  }

  /** Push the whole state; used when a webview (re)connects. */
  emitFullState(): void {
    this.#emit({
      type: "state",
      state: { meta: this.#meta, items: this.#items, dialog: null },
    });
  }

  /* ---------------------------- mutations --------------------------- */

  addUserMessage(text: string, attachments: readonly Attachment[]): string {
    const id = this.#nextId("u");
    this.#push({
      kind: "user",
      id,
      text,
      attachments,
      at: Date.now(),
    });
    this.#pendingUserEcho.push(text);
    return id;
  }

  addNote(level: NoteLevel, text: string, detail?: string): string {
    const id = this.#nextId("n");
    this.#push({
      kind: "note",
      id,
      text,
      level,
      at: Date.now(),
      ...(detail !== undefined ? { detail } : {}),
    });
    return id;
  }

  /** Drop everything, e.g. before switching sessions. */
  reset(): void {
    this.#items = [];
    this.#assistantId = null;
    this.#lastToolCallId = null;
    this.#toolItemByCallId.clear();
    this.#bashItemByRequestId.clear();
    this.#pendingUserEcho.length = 0;
    this.#baseStats = null;
    this.#committedUsage = ZERO_COUNTERS;
    this.#streamingUsage = ZERO_COUNTERS;
    this.#lastPromptTokens = 0;
    this.#emit({ type: "items", items: this.#items });
    this.#emitStats();
    this.#updateBashRunning();
  }

  /* ------------------------- direct shell runs ---------------------- */

  /** Render a `!command` run started from the composer. */
  beginBash(command: string, requestId: string): string {
    const id = this.#nextId("b");
    const item: BashItem = { kind: "bash", id, command, output: "", at: Date.now(), streaming: true };
    this.#items.push(item);
    this.#bashItemByRequestId.set(requestId, id);
    this.#emit({ type: "item", item });
    this.#updateBashRunning();
    return id;
  }

  /** Finalize a `!command` run with the RPC response payload. */
  endBash(requestId: string, data: unknown): void {
    const itemId = this.#bashItemByRequestId.get(requestId);
    if (itemId === undefined) return;
    this.#bashItemByRequestId.delete(requestId);
    const index = this.#items.findIndex((entry) => entry.id === itemId);
    const current = index === -1 ? undefined : this.#items[index];
    if (current?.kind !== "bash") return;
    const record = asRecord(data);
    const responseOutput = str(record["output"]) ?? "";
    // Streamed chunks include output the final (possibly truncated) response drops.
    const output = current.output.length >= responseOutput.length ? current.output : responseOutput;
    const exitCode = num(record["exitCode"]);
    const fullOutputPath = str(record["fullOutputPath"]);
    this.#patchItem(itemId, {
      streaming: false,
      ...(output !== current.output ? { output } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(record["cancelled"] === true ? { cancelled: true } : {}),
      ...(record["truncated"] === true ? { truncated: true } : {}),
      ...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
    });
    this.#updateBashRunning();
  }

  /** Mark every in-flight `!command` as stopped (abort, engine exit). */
  endAllBash(): void {
    let changed = false;
    for (const item of this.#items) {
      if (item.kind === "bash" && item.streaming) {
        this.#patchItem(item.id, { streaming: false, cancelled: true });
        changed = true;
      }
    }
    this.#bashItemByRequestId.clear();
    if (changed) this.#updateBashRunning();
  }

  /** Rebuild items from `get_messages`, optionally attaching fork entry ids. */
  setHistory(
    messages: readonly Record<string, unknown>[],
    forkMessages: readonly { entryId: string; text: string }[] = [],
  ): void {
    const items: ChatItem[] = [];
    const toolItems = new Map<string, ToolItem>();
    let counter = 0;
    const nextId = (prefix: string): string => `${prefix}h${++counter}`;

    for (const message of messages) {
      const role = str(message["role"]);
      const at = num(message["timestamp"]) ?? Date.now();
      if (role === "user") {
        items.push({
          kind: "user",
          id: nextId("u"),
          text: contentText(message["content"]),
          attachments: contentAttachments(message["content"]),
          at,
        });
        continue;
      }
      if (role === "assistant") {
        const content = message["content"];
        items.push({
          kind: "assistant",
          id: nextId("a"),
          text: contentText(content),
          thinking: contentThinking(content),
          at,
          streaming: false,
          ...(str(message["model"]) !== undefined ? { model: str(message["model"]) } : {}),
          ...(str(message["stopReason"]) === "error"
            ? { error: str(message["errorMessage"]) ?? "error" }
            : {}),
        });
        if (Array.isArray(content)) {
          for (const block of content) {
            const record = asRecord(block);
            if (record["type"] !== "toolCall") continue;
            const callId = str(record["id"]);
            const name = str(record["name"]);
            if (callId === undefined || name === undefined) continue;
            const tool: ToolItem = {
              kind: "tool",
              id: nextId("t"),
              name,
              args: asRecord(record["arguments"]),
              status: "running",
              output: "",
              startedAt: at,
            };
            items.push(tool);
            toolItems.set(callId, tool);
          }
        }
        continue;
      }
      if (role === "toolResult") {
        const callId = str(message["toolCallId"]);
        const tool = callId !== undefined ? toolItems.get(callId) : undefined;
        if (tool === undefined) continue;
        const content = readToolResult(
          { content: message["content"], details: message["details"] },
          tool.args,
        );
        Object.assign(tool, {
          status: message["isError"] === true ? "error" : "ok",
          output: content.text,
          endedAt: at,
          ...(content.diff !== undefined ? { diff: content.diff } : {}),
          ...(content.filePath !== undefined ? { filePath: content.filePath } : {}),
          ...(content.line !== undefined ? { line: content.line } : {}),
          ...(content.truncated !== undefined ? { truncated: content.truncated } : {}),
          ...(content.fullOutputPath !== undefined ? { fullOutputPath: content.fullOutputPath } : {}),
        });
        continue;
      }
      if (role === "bashExecution") {
        items.push({
          kind: "bash",
          id: nextId("b"),
          command: str(message["command"]) ?? "",
          output: str(message["output"]) ?? "",
          at,
          streaming: false,
          ...(num(message["exitCode"]) !== undefined ? { exitCode: num(message["exitCode"]) } : {}),
          ...(message["cancelled"] === true ? { cancelled: true } : {}),
          ...(message["truncated"] === true ? { truncated: true } : {}),
          ...(str(message["fullOutputPath"]) !== undefined ? { fullOutputPath: str(message["fullOutputPath"]) } : {}),
        });
      }
    }

    // Attach entry ids so "branch from here" works on history items too.
    if (forkMessages.length > 0) {
      let cursor = 0;
      for (const item of items) {
        if (item.kind !== "user") continue;
        while (cursor < forkMessages.length && forkMessages[cursor]?.text !== item.text) cursor += 1;
        const match = forkMessages[cursor];
        if (match !== undefined && match.text === item.text) {
          (item as { entryId?: string }).entryId = match.entryId;
          cursor += 1;
        }
      }
    }

    this.#items = items;
    this.#assistantId = null;
    this.#toolItemByCallId.clear();
    this.#bashItemByRequestId.clear();
    this.#pendingUserEcho.length = 0;
    this.#emit({ type: "items", items: this.#items });
    this.#updateBashRunning();
  }

  /**
   * Attach entry ids to user items that were rendered optimistically, so
   * "branch from here" works without a full history reload.
   */
  attachForkEntryIds(forkMessages: readonly { entryId: string; text: string }[]): void {
    if (forkMessages.length === 0) return;
    let cursor = 0;
    for (let index = 0; index < this.#items.length; index += 1) {
      const item = this.#items[index];
      if (item?.kind !== "user") continue;
      while (cursor < forkMessages.length && forkMessages[cursor]?.text !== item.text) cursor += 1;
      const match = forkMessages[cursor];
      if (match === undefined || match.text !== item.text) continue;
      cursor += 1;
      if (item.entryId === match.entryId) continue;
      const next: ChatItem = { ...item, entryId: match.entryId };
      this.#items[index] = next;
      this.#emit({ type: "item", item: next });
    }
  }

  /* ----------------------------- events ----------------------------- */

  applyEvent(event: unknown): void {
    const record = asRecord(event);
    switch (str(record["type"])) {
      case "agent_start":
        this.setMeta({ isStreaming: true });
        break;
      case "agent_settled":
        this.#commitStreamingUsage(null);
        this.setMeta({ isStreaming: false, isCompacting: false });
        this.#settleStreaming();
        break;
      case "agent_end":
        this.#commitStreamingUsage(null);
        this.#settleStreaming();
        break;
      case "turn_end":
        this.#settleTools();
        break;
      case "message_start":
        this.#onMessageStart(record["message"]);
        break;
      case "message_update":
        this.#onMessageUpdate(record);
        break;
      case "message_end":
        this.#onMessageEnd(record["message"]);
        break;
      case "tool_execution_start":
        this.#onToolStart(record);
        break;
      case "tool_execution_update":
        this.#onToolUpdate(record);
        break;
      case "tool_execution_end":
        this.#onToolEnd(record);
        break;
      case "queue_update":
        this.setMeta({
          queue: {
            steering: Array.isArray(record["steering"]) ? (record["steering"] as string[]) : [],
            followUp: Array.isArray(record["followUp"]) ? (record["followUp"] as string[]) : [],
          },
        });
        break;
      case "compaction_start":
        this.#onCompactionStart(record);
        break;
      case "compaction_end":
        this.#onCompactionEnd(record);
        break;
      case "bash_execution_update": {
        const requestId = str(record["id"]);
        const delta = str(record["delta"]);
        if (requestId !== undefined && delta !== undefined && delta.length > 0) {
          this.#appendBash(requestId, delta);
        }
        break;
      }
      case "auto_retry_start": {
        const attempt = num(record["attempt"]) ?? 1;
        const max = num(record["maxAttempts"]) ?? 1;
        const message = str(record["errorMessage"]) ?? "transient error";
        this.addNote("warn", `Retrying (${attempt}/${max}) after ${firstLine(message)}`);
        break;
      }
      case "auto_retry_end":
        if (record["success"] === false) {
          this.addNote("error", `Retries exhausted: ${firstLine(str(record["finalError"]) ?? "unknown")}`);
        }
        break;
      case "extension_error":
        this.addNote(
          "error",
          `Extension error in ${firstLine(str(record["extensionPath"]) ?? "extension")}`,
          str(record["error"]),
        );
        break;
      default:
        break;
    }
  }

  /* --------------------------- event handlers ----------------------- */

  #onMessageStart(raw: unknown): void {
    const message = asRecord(raw);
    const role = str(message["role"]);
    if (role === "assistant") {
      this.#ensureAssistant();
      return;
    }
    if (role === "user") this.#handleUserEcho(contentText(message["content"]));
  }

  #onMessageEnd(raw: unknown): void {
    const message = asRecord(raw);
    const role = str(message["role"]);
    if (role === "user") {
      this.#handleUserEcho(contentText(message["content"]));
      return;
    }
    if (role !== "assistant") return;

    this.#commitStreamingUsage(parseMessageUsage(message["usage"]));

    const item = this.#assistantItem();
    if (item === undefined) return;
    const content = message["content"];
    const patch: Record<string, unknown> = {
      text: contentText(content),
      thinking: contentThinking(content),
      streaming: false,
    };
    const model = str(message["model"]);
    if (model !== undefined) patch["model"] = model;
    if (str(message["stopReason"]) === "error") {
      patch["error"] = str(message["errorMessage"]) ?? "the model returned an error";
    }
    this.#patchItem(item.id, patch);

    if (Array.isArray(content)) {
      for (const block of content) {
        const blockRecord = asRecord(block);
        if (blockRecord["type"] !== "toolCall") continue;
        const callId = str(blockRecord["id"]);
        const name = str(blockRecord["name"]);
        if (callId === undefined || name === undefined) continue;
        this.#upsertTool(callId, name, asRecord(blockRecord["arguments"]));
      }
    }
    this.#assistantId = null;
  }

  #onMessageUpdate(record: Record<string, unknown>): void {
    const delta = asRecord(record["assistantMessageEvent"]);
    const type = str(delta["type"]);
    if (type === undefined) return;
    this.#setStreamingUsage(parseMessageUsage(record["usage"]));
    switch (type) {
      case "text_start":
      case "thinking_start":
        this.#ensureAssistant();
        break;
      case "text_delta":
        this.#appendAssistant("text", str(delta["delta"]) ?? "");
        break;
      case "thinking_delta":
        this.#appendAssistant("thinking", str(delta["delta"]) ?? "");
        break;
      case "toolcall_start": {
        const callId = str(delta["id"]);
        const name = str(delta["toolName"]);
        if (callId === undefined || name === undefined) return;
        this.#lastToolCallId = callId;
        this.#upsertTool(callId, name, {});
        break;
      }
      case "toolcall_delta": {
        const callId = str(delta["id"]) ?? this.#lastToolCallId;
        if (callId === null || callId === undefined) return;
        this.#appendToolArgs(callId, str(delta["delta"]) ?? "");
        break;
      }
      case "toolcall_end": {
        const call = asRecord(delta["toolCall"]);
        const callId = str(call["id"]) ?? str(delta["id"]) ?? this.#lastToolCallId;
        const name = str(call["name"]) ?? str(delta["toolName"]);
        if (callId === null || callId === undefined || name === undefined) return;
        this.#upsertTool(callId, name, asRecord(call["arguments"]));
        break;
      }
      default:
        break;
    }
  }

  #onToolStart(record: Record<string, unknown>): void {
    const callId = str(record["toolCallId"]);
    const name = str(record["toolName"]);
    if (callId === undefined || name === undefined) return;
    this.#lastToolCallId = callId;
    this.#upsertTool(callId, name, asRecord(record["args"]));
  }

  #onToolUpdate(record: Record<string, unknown>): void {
    const callId = str(record["toolCallId"]);
    if (callId === undefined) return;
    const item = this.#toolItem(callId);
    if (item === undefined) return;
    const partial = asRecord(record["partialResult"]);
    const text = contentText(partial["content"]);
    const delta = text.startsWith(item.output) ? text.slice(item.output.length) : text;
    this.#patchItem(
      item.id,
      { output: text },
      delta.length > 0 ? { field: "output", text: delta } : undefined,
    );
  }

  #onToolEnd(record: Record<string, unknown>): void {
    const callId = str(record["toolCallId"]);
    if (callId === undefined) return;
    const name = str(record["toolName"]);
    if (name !== undefined) this.#upsertTool(callId, name, asRecord(record["args"]));
    const item = this.#toolItem(callId);
    if (item === undefined) return;
    const content = readToolResult(record["result"], item.args);
    this.#patchItem(item.id, {
      status: record["isError"] === true ? "error" : "ok",
      output: content.text,
      endedAt: Date.now(),
      ...(content.diff !== undefined ? { diff: content.diff } : {}),
      ...(content.filePath !== undefined ? { filePath: content.filePath } : {}),
      ...(content.line !== undefined ? { line: content.line } : {}),
      ...(content.truncated !== undefined ? { truncated: content.truncated } : {}),
      ...(content.fullOutputPath !== undefined ? { fullOutputPath: content.fullOutputPath } : {}),
    });
  }

  #onCompactionStart(record: Record<string, unknown>): void {
    const reason = str(record["reason"]) ?? "manual";
    const id = this.#nextId("c");
    this.#push({
      kind: "compaction",
      id,
      text: `Compacting context (${reason})…`,
      at: Date.now(),
      streaming: true,
    });
    this.setMeta({ isCompacting: true });
  }

  #onCompactionEnd(record: Record<string, unknown>): void {
    const item = [...this.#items].reverse().find((entry): entry is CompactionItem => entry.kind === "compaction");
    const result = asRecord(record["result"]);
    const summary = str(result["summary"]);
    const tokensBefore = num(result["tokensBefore"]);
    const tokensAfter = num(result["estimatedTokensAfter"]);
    const aborted = record["aborted"] === true;
    const errorMessage = str(record["errorMessage"]);
    if (item !== undefined) {
      this.#patchItem(item.id, {
        streaming: false,
        text: aborted
          ? "Compaction cancelled."
          : errorMessage !== undefined
            ? `Compaction failed: ${firstLine(errorMessage)}`
            : summary !== undefined
              ? summary
              : "Context compacted.",
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      });
    }
    this.setMeta({ isCompacting: false });
  }

  /* ----------------------------- internals -------------------------- */

  #appendBash(requestId: string, delta: string): void {
    const itemId = this.#bashItemByRequestId.get(requestId);
    if (itemId === undefined) return;
    const index = this.#items.findIndex((entry) => entry.id === itemId);
    const current = index === -1 ? undefined : this.#items[index];
    if (current?.kind !== "bash") return;
    this.#patchItem(itemId, { output: current.output + delta }, { field: "output", text: delta });
  }

  #updateBashRunning(): void {
    const running = this.#items.some((item) => item.kind === "bash" && item.streaming);
    if (this.#meta.isBashRunning !== running) this.setMeta({ isBashRunning: running });
  }

  /** Replace the cumulative usage reported for the streaming message. */
  #setStreamingUsage(usage: UsageCounters | null): void {
    if (usage === null || sameCounters(usage, this.#streamingUsage)) return;
    this.#streamingUsage = usage;
    this.#rememberPrompt(usage);
    this.#emitStats();
  }

  /**
   * Fold the finished message's usage into the running totals. A fresh
   * `get_session_stats` snapshot later replaces both, so the counters only
   * bridge the gap between `message_end` and the next stats refresh.
   */
  #commitStreamingUsage(usage: UsageCounters | null): void {
    const final = usage ?? this.#streamingUsage;
    if (!hasUsage(final) && !hasUsage(this.#streamingUsage)) return;
    this.#committedUsage = addCounters(this.#committedUsage, final);
    this.#streamingUsage = ZERO_COUNTERS;
    this.#rememberPrompt(final);
    this.#emitStats();
  }

  /**
   * Remember the newest prompt size. In a tool loop a turn spans several
   * assistant messages, and only the latest prompt reflects the context.
   */
  #rememberPrompt(usage: UsageCounters): void {
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    if (prompt > 0) this.#lastPromptTokens = prompt;
  }

  /** Merge the session snapshot with the live counters and publish it. */
  #emitStats(): void {
    const base = this.#baseStats;
    const live = addCounters(this.#committedUsage, this.#streamingUsage);
    const liveActive = hasUsage(live);
    if (base === null && !liveActive) {
      if (this.#meta.stats !== null) this.setMeta({ stats: null });
      return;
    }

    let contextTokens = base?.contextTokens;
    let contextPercent = base?.contextPercent;
    const contextWindow = base?.contextWindow;
    const promptTokens = this.#lastPromptTokens;
    if (promptTokens > 0 && contextWindow !== undefined && contextWindow > 0) {
      // A streaming prompt *is* the current context, so this tracks compaction
      // thresholds live instead of waiting for the next turn to end.
      contextTokens = promptTokens;
      contextPercent = Math.min(100, (promptTokens / contextWindow) * 100);
    }

    this.setMeta({
      stats: {
        input: (base?.input ?? 0) + live.input,
        output: (base?.output ?? 0) + live.output,
        cacheRead: (base?.cacheRead ?? 0) + live.cacheRead,
        cacheWrite: (base?.cacheWrite ?? 0) + live.cacheWrite,
        totalTokens:
          (base?.totalTokens ?? 0) + live.input + live.output + live.cacheRead + live.cacheWrite,
        cost: (base?.cost ?? 0) + live.cost,
        ...(contextTokens !== undefined ? { contextTokens } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(contextPercent !== undefined ? { contextPercent } : {}),
        ...(liveActive ? { live: true } : {}),
      },
    });
  }

  #handleUserEcho(text: string): void {
    if (this.#pendingUserEcho[0] === text) {
      this.#pendingUserEcho.shift();
      return;
    }
    // pi may emit both message_start and message_end for the same user
    // message; never render it twice.
    const last = this.#items.at(-1);
    if (last?.kind === "user" && last.text === text && Date.now() - last.at < 10_000) return;
    // A user message we did not render (e.g. queued by another client).
    this.#push({ kind: "user", id: this.#nextId("u"), text, attachments: [], at: Date.now() });
  }

  #ensureAssistant(): AssistantItemInternal {
    const existing = this.#assistantItem();
    if (existing !== undefined) return existing;
    const item: AssistantItemInternal = {
      kind: "assistant",
      id: this.#nextId("a"),
      text: "",
      thinking: "",
      at: Date.now(),
      streaming: true,
    };
    this.#items.push(item);
    this.#assistantId = item.id;
    this.#emit({ type: "item", item });
    return item;
  }

  #assistantItem(): AssistantItemInternal | undefined {
    if (this.#assistantId === null) return undefined;
    const found = this.#items.find((item) => item.id === this.#assistantId);
    return found?.kind === "assistant" ? (found as AssistantItemInternal) : undefined;
  }

  #appendAssistant(field: "text" | "thinking", delta: string): void {
    if (delta.length === 0) return;
    const item = this.#ensureAssistant();
    item[field] += delta;
    this.#emit({ type: "delta", id: item.id, field, delta });
  }

  #appendToolArgs(callId: string, delta: string): void {
    if (delta.length === 0) return;
    const item = this.#toolItem(callId);
    if (item === undefined) return;
    this.#patchItem(item.id, { argsText: `${item.argsText ?? ""}${delta}` }, { field: "argsText", text: delta });
  }

  #upsertTool(callId: string, name: string, args: Record<string, unknown>): ToolItem {
    const existingId = this.#toolItemByCallId.get(callId);
    if (existingId !== undefined) {
      const found = this.#items.find((item) => item.id === existingId);
      if (found?.kind === "tool") {
        const patch: Record<string, unknown> = { name };
        if (Object.keys(args).length > 0) {
          patch["args"] = args;
          patch["argsText"] = "";
        }
        this.#patchItem(existingId, patch);
        return found as ToolItem;
      }
    }
    const item: ToolItem = {
      kind: "tool",
      id: this.#nextId("t"),
      name,
      args,
      argsText: "",
      status: "running",
      output: "",
      startedAt: Date.now(),
    };
    this.#items.push(item);
    this.#toolItemByCallId.set(callId, item.id);
    this.#emit({ type: "item", item });
    return item;
  }

  #toolItem(callId: string): ToolItem | undefined {
    const id = this.#toolItemByCallId.get(callId);
    if (id === undefined) return undefined;
    const found = this.#items.find((item) => item.id === id);
    return found?.kind === "tool" ? (found as ToolItem) : undefined;
  }

  #settleStreaming(): void {
    const item = this.#assistantItem();
    if (item !== undefined) this.#patchItem(item.id, { streaming: false });
    this.#assistantId = null;
  }

  #settleTools(): void {
    for (const item of this.#items) {
      if (item.kind === "tool" && item.status === "running") {
        this.#patchItem(item.id, { status: "ok", endedAt: Date.now() });
      }
    }
  }

  /**
   * Replace an item with a patched copy and notify the webview. When `delta`
   * is given the webview only receives the appended text, which keeps
   * streaming updates cheap.
   */
  #patchItem(
    id: string,
    patch: Record<string, unknown>,
    delta?: { field: "text" | "thinking" | "output" | "argsText"; text: string },
  ): void {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index === -1) return;
    const next = { ...this.#items[index], ...patch } as ChatItem;
    this.#items[index] = next;
    if (delta !== undefined) {
      this.#emit({ type: "delta", id, field: delta.field, delta: delta.text });
      return;
    }
    this.#emit({ type: "item", item: next });
  }

  #push(item: ChatItem): void {
    this.#items.push(item);
    this.#emit({ type: "item", item });
  }

  #nextId(prefix: string): string {
    this.#counter += 1;
    return `${prefix}${this.#counter}`;
  }
}

interface AssistantItemInternal {
  kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  at: number;
  streaming: boolean;
  model?: string;
  error?: string;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? text;
}
