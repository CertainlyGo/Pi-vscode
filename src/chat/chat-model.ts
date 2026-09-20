import type {
  Attachment,
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
  readonly #toolItemByCallId = new Map<string, string>();
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
    this.#pendingUserEcho.length = 0;
    this.#emit({ type: "items", items: this.#items });
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
    this.#pendingUserEcho.length = 0;
    this.#emit({ type: "items", items: this.#items });
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
        this.setMeta({ isStreaming: false, isCompacting: false });
        this.#settleStreaming();
        break;
      case "agent_end":
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
