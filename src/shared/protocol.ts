/**
 * The contract between the extension host and the chat webview.
 *
 * The host owns the authoritative chat state (it consumes pi's RPC event stream)
 * and pushes granular updates; the webview is a pure renderer that sends user
 * intents back. Keep this file dependency-free so both bundles can import it.
 */

export type EngineStatus = "idle" | "starting" | "ready" | "stopping" | "stopped" | "crashed";

export type AttachmentKind = "file" | "selection" | "image";

export interface Attachment {
  readonly kind: AttachmentKind;
  /** Workspace-relative POSIX path. */
  readonly path: string;
  readonly label: string;
  /** File/selection text, or base64 payload for images. */
  readonly text?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly mimeType?: string;
}

export type ToolStatus = "running" | "ok" | "error";

export interface ToolItem {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** Raw partial JSON while the model is still emitting the call. */
  readonly argsText?: string;
  readonly status: ToolStatus;
  readonly output: string;
  readonly diff?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly filePath?: string;
  /** 1-based line of the first change, for editor navigation. */
  readonly line?: number;
  /** Short right-aligned summary, e.g. "12 matches". */
  readonly detail?: string;
  readonly truncated?: boolean;
  readonly fullOutputPath?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
}

export interface UserItem {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly at: number;
  /** Session entry id, used for "branch from here". */
  readonly entryId?: string;
}

export interface AssistantItem {
  readonly kind: "assistant";
  readonly id: string;
  readonly text: string;
  readonly thinking: string;
  readonly at: number;
  readonly streaming: boolean;
  readonly model?: string;
  readonly error?: string;
}

export type NoteLevel = "info" | "warn" | "error" | "success";

export interface NoteItem {
  readonly kind: "note";
  readonly id: string;
  readonly text: string;
  readonly level: NoteLevel;
  readonly detail?: string;
  readonly at: number;
}

export interface CompactionItem {
  readonly kind: "compaction";
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly streaming: boolean;
}

export interface BashItem {
  readonly kind: "bash";
  readonly id: string;
  readonly command: string;
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled?: boolean;
  readonly truncated?: boolean;
  readonly fullOutputPath?: string;
  readonly at: number;
  readonly streaming: boolean;
}

export type ChatItem = UserItem | AssistantItem | ToolItem | NoteItem | CompactionItem | BashItem;

export interface SessionSummary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly updatedAt: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

export interface UsageStats {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly contextPercent?: number;
}

export interface QueueState {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

export interface TrustState {
  readonly required: boolean;
  readonly decided: boolean;
  readonly workspace: string | null;
}

export interface Meta {
  readonly workspace: string | null;
  readonly workspaceName: string | null;
  readonly engine: EngineStatus;
  readonly engineError?: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly model: ModelInfo | null;
  readonly models: readonly ModelInfo[];
  readonly thinkingLevel: string;
  readonly thinkingLevels: readonly string[];
  readonly showThinking: boolean;
  readonly sessionName: string | null;
  readonly sessionFile: string | null;
  readonly sessions: readonly SessionSummary[];
  readonly stats: UsageStats | null;
  readonly queue: QueueState;
  readonly trust: TrustState;
  readonly piVersion?: string;
}

export interface DialogOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface SlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
}

export interface ProviderInfo {
  readonly id: string;
  /** `api_key` | `bearer_token` | `oauth` | `env` | `endpoint`. */
  readonly type: string;
  readonly masked: string;
  readonly source: "auth" | "env" | "endpoint";
  readonly baseUrl?: string;
  readonly api?: string;
  readonly models: readonly string[];
}

export interface OAuthPromptView {
  readonly type: "text" | "secret" | "select" | "manual_code";
  readonly message: string;
  readonly placeholder?: string;
  readonly options?: readonly { id: string; label: string; description?: string }[];
}

export type OAuthEventView =
  | { readonly kind: "info"; readonly message: string }
  | { readonly kind: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
      readonly kind: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresInSeconds?: number;
    }
  | { readonly kind: "progress"; readonly message: string };

export interface DialogRequest {
  readonly id: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly title?: string;
  readonly message?: string;
  readonly options?: readonly DialogOption[];
  readonly placeholder?: string;
  readonly defaultValue?: string;
  /** Set when the request comes from a third-party pi extension. */
  readonly source?: string;
}

export interface UiState {
  readonly meta: Meta;
  readonly items: readonly ChatItem[];
  readonly dialog: DialogRequest | null;
}

/* ------------------------------------------------------------------ */
/* Host -> webview                                                     */
/* ------------------------------------------------------------------ */

export type HostMessage =
  | { readonly type: "state"; readonly state: UiState }
  | { readonly type: "items"; readonly items: readonly ChatItem[] }
  | { readonly type: "item"; readonly item: ChatItem }
  | {
      readonly type: "delta";
      readonly id: string;
      readonly field: "text" | "thinking" | "output" | "argsText";
      readonly delta: string;
    }
  | { readonly type: "meta"; readonly meta: Meta }
  | { readonly type: "dialog"; readonly dialog: DialogRequest | null }
  | { readonly type: "notice"; readonly level: NoteLevel; readonly message: string }
  | { readonly type: "files"; readonly files: readonly string[] }
  | { readonly type: "commands"; readonly commands: readonly SlashCommand[] }
  | {
      readonly type: "providers";
      readonly providers: readonly ProviderInfo[];
      readonly oauthAvailable: boolean;
    }
  | { readonly type: "providerStatus"; readonly ok: boolean; readonly message: string; readonly busy: boolean }
  | { readonly type: "oauthPrompt"; readonly prompt: OAuthPromptView | null }
  | { readonly type: "oauthEvent"; readonly event: OAuthEventView }
  | { readonly type: "attach"; readonly attachment: Attachment }
  | { readonly type: "setDraft"; readonly text: string }
  | { readonly type: "openProviders" }
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "focus" };

/* ------------------------------------------------------------------ */
/* Webview -> host                                                     */
/* ------------------------------------------------------------------ */

export type PromptMode = "send" | "steer" | "followUp";

export type WebviewMessage =
  | { readonly type: "ready" }
  | {
      readonly type: "prompt";
      readonly text: string;
      readonly mode: PromptMode;
      readonly attachments: readonly Attachment[];
    }
  | { readonly type: "abort" }
  | { readonly type: "newSession" }
  | { readonly type: "switchSession"; readonly path: string }
  | { readonly type: "deleteSession"; readonly path: string }
  | { readonly type: "renameSession"; readonly name: string }
  | { readonly type: "fork"; readonly entryId: string }
  | { readonly type: "setModel"; readonly provider: string; readonly modelId: string }
  | { readonly type: "setThinking"; readonly level: string }
  | { readonly type: "refresh" }
  | { readonly type: "requestFiles" }
  | { readonly type: "requestProviders" }
  | {
      readonly type: "addApiKey";
      readonly provider: string;
      readonly key: string;
      readonly baseUrl?: string;
    }
  | {
      readonly type: "addCustomProvider";
      readonly id: string;
      readonly api: string;
      readonly baseUrl: string;
      readonly key: string;
      readonly models: readonly string[];
    }
  | { readonly type: "removeCredential"; readonly provider: string }
  | { readonly type: "oauthLogin"; readonly provider: string }
  | { readonly type: "oauthCancel" }
  | { readonly type: "oauthPromptResponse"; readonly value: string | null }
  | {
      readonly type: "dialogResponse";
      readonly id: string;
      readonly response: Record<string, unknown>;
    }
  | { readonly type: "openDiff"; readonly id: string }
  | { readonly type: "openFile"; readonly path: string; readonly line?: number }
  | { readonly type: "restartEngine" }
  | { readonly type: "openLogs" }
  | { readonly type: "trust"; readonly decision: "always" | "never" }
  | { readonly type: "retry"; readonly text: string };

export const EMPTY_META: Meta = {
  workspace: null,
  workspaceName: null,
  engine: "idle",
  isStreaming: false,
  isCompacting: false,
  model: null,
  models: [],
  thinkingLevel: "medium",
  thinkingLevels: [],
  showThinking: true,
  sessionName: null,
  sessionFile: null,
  sessions: [],
  stats: null,
  queue: { steering: [], followUp: [] },
  trust: { required: false, decided: true, workspace: null },
};
