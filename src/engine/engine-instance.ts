import { JsonlDecoder } from "./rpc-frames";
import { RpcPeer } from "./rpc-peer";
import type { ExtensionUiRequest } from "./rpc-peer";

/**
 * Engine state machine:
 * idle -> starting -> ready -> stopping -> stopped
 *                       \-> crashed (spawn failure / unexpected exit)
 */
export type EngineStatus = "idle" | "starting" | "ready" | "stopping" | "stopped" | "crashed";

export interface EngineExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Minimal surface the supervisor needs; tests can supply a fake. */
export interface EngineProcess {
  readonly pid: number | undefined;
  write(record: string): void;
  endInput(): void;
  kill(): void;
  killTree(): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (info: EngineExitInfo) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface EngineInstanceOptions {
  /** Absolute path of the workspace; also the child's cwd. */
  readonly workspace: string;
  /** Actually spawn the child. Called once, from start(). */
  readonly start: () => EngineProcess;
  readonly probeType?: string;
  readonly probeTimeoutMs?: number;
  readonly stopGraceMs?: number;
  /** 0 disables idle recycling. */
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
  readonly onEvent?: (message: unknown) => void;
  readonly onStatusChange?: (status: EngineStatus, instance: EngineInstance) => void;
  readonly onExtensionUiRequest?: (request: ExtensionUiRequest) => void;
  /** Non-fatal protocol problems worth surfacing to the user. */
  readonly onWarning?: (error: Error) => void;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const STDERR_TAIL_LIMIT = 8 * 1024;

/**
 * Supervise one pi engine subprocess bound to a single workspace. This class
 * only spawns, pipes bytes into {@link RpcPeer}, translates exit/error into
 * status, and stops the child gracefully. No business semantics live here.
 */
export class EngineInstance {
  readonly workspace: string;
  readonly #options: EngineInstanceOptions;
  readonly #idleTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #probeType: string;
  readonly #probeTimeoutMs: number;
  readonly #now: () => number;

  #status: EngineStatus = "idle";
  #child: EngineProcess | undefined;
  #peer: RpcPeer | undefined;
  #decoder = new JsonlDecoder();
  #stderrTail = "";
  #lastActivityAt: number;
  #exitInfo: EngineExitInfo | undefined;
  #exitWaiters: Array<(info: EngineExitInfo | undefined) => void> = [];

  constructor(options: EngineInstanceOptions) {
    this.workspace = options.workspace;
    this.#options = options;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.#probeType = options.probeType ?? "get_state";
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#lastActivityAt = this.#now();
  }

  get status(): EngineStatus {
    return this.#status;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Bounded tail of the engine's stderr, used to explain startup failures. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  get peer(): RpcPeer {
    if (this.#peer === undefined) throw new Error(`engine not started: ${this.workspace}`);
    return this.#peer;
  }

  /** Start the engine and confirm it is alive. Idempotent. */
  async start(): Promise<void> {
    if (this.#status === "starting" || this.#status === "ready") return;
    if (this.#status === "stopping") throw new Error(`engine is stopping: ${this.workspace}`);

    this.#exitInfo = undefined;
    this.#decoder = new JsonlDecoder();
    this.#setStatus("starting");

    let child: EngineProcess;
    try {
      child = this.#options.start();
    } catch (error) {
      this.#setStatus("crashed");
      throw error;
    }
    this.#child = child;

    const peer = new RpcPeer({ send: (record) => child.write(record) });
    this.#peer = peer;
    peer.onEvent((message) => {
      this.#lastActivityAt = this.#now();
      this.#options.onEvent?.(message);
    });
    peer.onExtensionUiRequest((request) => {
      this.#lastActivityAt = this.#now();
      this.#options.onExtensionUiRequest?.(request);
    });

    child.onStdout((chunk) => this.#handleStdout(chunk));
    child.onStderr((chunk) => this.#handleStderr(chunk));
    child.onExit((info) => this.#handleExit(info));
    child.onError((error) => {
      this.#options.onWarning?.(error);
      this.#setStatus("crashed");
    });

    try {
      await peer.request({ type: this.#probeType }, { timeoutMs: this.#probeTimeoutMs });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const stderr = this.#stderrTail.trim();
      await this.stop();
      this.#setStatus("crashed");
      throw new Error(
        `engine failed to start: ${detail}${stderr.length > 0 ? `\n--- stderr ---\n${stderr}` : ""}`,
      );
    }

    this.#lastActivityAt = this.#now();
    this.#setStatus("ready");
  }

  /** Stop gracefully: stdin end -> kill -> killTree. Idempotent. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) {
      this.#setStatus("stopped");
      return;
    }
    if (this.#status === "stopping") {
      await this.#waitForExit(this.#stopGraceMs * 2);
      return;
    }

    this.#setStatus("stopping");
    this.#peer?.dispose("engine is stopping");
    child.endInput();

    if (await this.#waitForExit(this.#stopGraceMs)) return;
    child.kill();
    if (await this.#waitForExit(this.#stopGraceMs)) return;
    child.killTree();
    this.#child = undefined;
    this.#setStatus("stopped");
  }

  /** True when a ready engine has been idle past the recycle threshold. */
  isIdle(): boolean {
    return (
      this.#status === "ready" &&
      this.#idleTimeoutMs > 0 &&
      this.#now() - this.#lastActivityAt >= this.#idleTimeoutMs
    );
  }

  /* ------------------------------------------------------------------ */
  /* Commands                                                            */
  /* ------------------------------------------------------------------ */

  prompt(
    text: string,
    options: {
      images?: readonly { type: "image"; data: string; mimeType: string }[];
      streamingBehavior?: "steer" | "followUp";
    } = {},
  ): Promise<Record<string, unknown>> {
    return this.peer.request({
      type: "prompt",
      message: text,
      ...(options.images !== undefined && options.images.length > 0 ? { images: options.images } : {}),
      ...(options.streamingBehavior !== undefined ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  steer(text: string): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "steer", message: text });
  }

  followUp(text: string): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "follow_up", message: text });
  }

  abort(): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "abort" });
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const data = await this.#requestData({ type: "clear_queue" });
    return {
      steering: Array.isArray(data?.["steering"]) ? (data["steering"] as string[]) : [],
      followUp: Array.isArray(data?.["followUp"]) ? (data["followUp"] as string[]) : [],
    };
  }

  getState(): Promise<Record<string, unknown> | undefined> {
    return this.#requestData({ type: "get_state" });
  }

  async getSessionStats(): Promise<Record<string, unknown> | undefined> {
    return this.#requestData({ type: "get_session_stats" });
  }

  async listModels(): Promise<readonly Record<string, unknown>[]> {
    const data = await this.#requestData({ type: "get_available_models" });
    const models = data?.["models"];
    return Array.isArray(models) ? (models as Record<string, unknown>[]) : [];
  }

  setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "set_model", provider, modelId });
  }

  async listThinkingLevels(): Promise<readonly string[]> {
    const data = await this.#requestData({ type: "get_available_thinking_levels" });
    const levels = data?.["levels"];
    return Array.isArray(levels) ? (levels as string[]) : ["off"];
  }

  setThinkingLevel(level: string): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "set_thinking_level", level });
  }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    const data = await this.#requestData({
      type: "new_session",
      ...(parentSession !== undefined ? { parentSession } : {}),
    });
    return { cancelled: data?.["cancelled"] === true };
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const data = await this.#requestData({ type: "switch_session", sessionPath });
    return { cancelled: data?.["cancelled"] === true };
  }

  async fork(entryId: string): Promise<{ cancelled: boolean }> {
    const data = await this.#requestData({ type: "fork", entryId });
    return { cancelled: data?.["cancelled"] === true };
  }

  async getMessages(): Promise<readonly Record<string, unknown>[]> {
    const data = await this.#requestData({ type: "get_messages" });
    const messages = data?.["messages"];
    return Array.isArray(messages) ? (messages as Record<string, unknown>[]) : [];
  }

  async getCommands(): Promise<readonly Record<string, unknown>[]> {
    const data = await this.#requestData({ type: "get_commands" });
    const commands = data?.["commands"];
    return Array.isArray(commands) ? (commands as Record<string, unknown>[]) : [];
  }

  /** User messages on the active branch that can be forked from. */
  async getForkMessages(): Promise<readonly { entryId: string; text: string }[]> {
    const data = await this.#requestData({ type: "get_fork_messages" });
    const messages = data?.["messages"];
    if (!Array.isArray(messages)) return [];
    const result: { entryId: string; text: string }[] = [];
    for (const entry of messages) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const entryId = record["entryId"];
      const text = record["text"];
      if (typeof entryId === "string" && typeof text === "string") result.push({ entryId, text });
    }
    return result;
  }

  async setSessionName(name: string): Promise<boolean> {
    const response = await this.peer.request({ type: "set_session_name", name });
    return response["success"] !== false;
  }

  respondExtensionUi(id: string, response: Record<string, unknown>): void {
    this.peer.respondToExtensionUi({ type: "extension_ui_response", id, ...response });
  }

  async #requestData(
    command: { readonly type: string } & Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const response = await this.peer.request(command);
    const data = response["data"];
    return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  #handleStdout(chunk: string): void {
    const outcome = this.#decoder.push(chunk);
    for (const error of outcome.errors) this.#options.onWarning?.(error);
    for (const record of outcome.records) {
      this.#lastActivityAt = this.#now();
      this.#peer?.handleMessage(record);
    }
  }

  #handleStderr(chunk: string): void {
    this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  }

  #handleExit(info: EngineExitInfo): void {
    this.#exitInfo = info;
    const leftover = this.#decoder.end();
    for (const error of leftover.errors) this.#options.onWarning?.(error);
    this.#peer?.dispose(`engine exited (code=${info.code ?? "null"})`);

    const expected = this.#status === "stopping";
    this.#setStatus(expected ? "stopped" : info.code === 0 ? "stopped" : "crashed");

    const waiters = this.#exitWaiters;
    this.#exitWaiters = [];
    for (const waiter of waiters) waiter(info);
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exitInfo !== undefined) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#exitWaiters.indexOf(waiter);
        if (index !== -1) this.#exitWaiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.#exitWaiters.push(waiter);
    });
  }

  #setStatus(status: EngineStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStatusChange?.(status, this);
  }
}
