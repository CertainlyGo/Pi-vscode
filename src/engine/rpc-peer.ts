import { encodeRecord } from "./rpc-frames";

/** Blocking dialogs an extension can request; the client must answer them. */
export const DIALOG_UI_METHODS = ["select", "confirm", "input", "editor"] as const;
export type DialogUiMethod = (typeof DIALOG_UI_METHODS)[number];

/** Fire-and-forget UI methods: the client may render them or ignore them. */
export const FIRE_AND_FORGET_UI_METHODS = [
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
] as const;

export interface ExtensionUiRequest {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: string;
  readonly [key: string]: unknown;
}

export interface ExtensionUiResponse {
  readonly type: "extension_ui_response";
  readonly id: string;
  readonly [key: string]: unknown;
}

export function isExtensionUiRequest(value: unknown): value is ExtensionUiRequest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["type"] === "extension_ui_request" && typeof record["id"] === "string";
}

export function isDialogUiMethod(method: string): method is DialogUiMethod {
  return (DIALOG_UI_METHODS as readonly string[]).includes(method);
}

export class RpcCommandError extends Error {
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.name = "RpcCommandError";
    this.command = command;
  }
}

export interface RpcRequestOptions {
  /** Timeout in ms. 0/undefined means no timeout (default: prompts can run long). */
  readonly timeoutMs?: number;
  /**
   * Called synchronously with the generated request id, before the command is
   * written. pi echoes the id on streamed events (e.g. `bash_execution_update`).
   */
  readonly onId?: (id: string) => void;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface RpcPeerOptions {
  readonly send: (record: string) => void;
  readonly newId?: () => string;
}

/**
 * Request/response correlation plus event routing over pi's RPC stream.
 * Responses are matched by `id`; `success: false` becomes a rejected
 * {@link RpcCommandError}; `extension_ui_request` goes to its own listener.
 */
export class RpcPeer {
  readonly #send: (record: string) => void;
  readonly #newId: () => string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #eventListeners = new Set<(message: unknown) => void>();
  readonly #uiListeners = new Set<(request: ExtensionUiRequest) => void>();
  #counter = 0;
  #disposed = false;

  constructor(options: RpcPeerOptions) {
    this.#send = options.send;
    this.#newId = options.newId ?? (() => `vscode-${++this.#counter}`);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  request(
    command: { readonly type: string } & Record<string, unknown>,
    options: RpcRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (this.#disposed) {
      return Promise.reject(new RpcCommandError("engine is not running", command.type));
    }
    const id = this.#newId();
    options.onId?.(id);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const pending: PendingRequest = { command: command.type, resolve, reject, timer: undefined };
      const timeoutMs = options.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new RpcCommandError(`command timed out (${timeoutMs}ms): ${command.type}`, command.type));
        }, timeoutMs);
        timer.unref();
        pending.timer = timer;
      }
      this.#pending.set(id, pending);
      this.#send(encodeRecord({ ...command, id }));
    });
  }

  /** Send a command that has no response. */
  notify(command: { readonly type: string } & Record<string, unknown>): void {
    if (this.#disposed) return;
    this.#send(encodeRecord(command));
  }

  respondToExtensionUi(response: ExtensionUiResponse): void {
    if (this.#disposed) return;
    this.#send(encodeRecord(response));
  }

  handleMessage(message: unknown): void {
    if (message === null || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record["type"] === "response") {
      this.#settle(record);
      return;
    }
    if (isExtensionUiRequest(message)) {
      for (const listener of this.#uiListeners) listener(message);
      return;
    }
    for (const listener of this.#eventListeners) listener(message);
  }

  onEvent(listener: (message: unknown) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onExtensionUiRequest(listener: (request: ExtensionUiRequest) => void): () => void {
    this.#uiListeners.add(listener);
    return () => this.#uiListeners.delete(listener);
  }

  /** Called when the engine dies: reject every in-flight request. */
  dispose(reason = "engine stopped"): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(new RpcCommandError(reason, entry.command));
    }
    this.#eventListeners.clear();
    this.#uiListeners.clear();
  }

  #settle(record: Record<string, unknown>): void {
    const id = record["id"];
    if (typeof id !== "string") return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return; // late response: drop quietly
    this.#pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);

    if (record["success"] === false) {
      const detail = typeof record["error"] === "string" ? record["error"] : "command failed";
      pending.reject(new RpcCommandError(detail, pending.command));
      return;
    }
    pending.resolve(record);
  }
}
