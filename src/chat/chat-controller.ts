import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { EngineInstance } from "../engine/engine-instance";
import type { EngineStatus } from "../engine/engine-instance";
import { EngineRegistry } from "../engine/engine-registry";
import { locatePi } from "../engine/locate-pi";
import type { PiLaunch } from "../engine/locate-pi";
import { spawnPiEngine } from "../engine/pi-process";
import { isDialogUiMethod } from "../engine/rpc-peer";
import type { ExtensionUiRequest } from "../engine/rpc-peer";
import { getAgentDir, deleteSession, listSessions } from "../sessions/session-store";
import { needsTrust, readTrustDecision, writeTrustDecision } from "../sessions/trust";
import { ProviderService } from "../providers/provider-service";
import type { OAuthProviderId } from "../providers/oauth";
import type {
  Attachment,
  DialogOption,
  DialogRequest,
  NoteLevel,
  OAuthPromptView,
  SlashCommand,
  WebviewMessage,
} from "../shared/protocol";
import { ChatModel, toModelInfo, toUsageStats } from "./chat-model";
import { ChatView } from "./chat-view";
import { PiDiffProvider } from "./diff-provider";

const MAX_ATTACHMENT_CHARS = 24_000;
const MAX_FILE_INDEX = 4_000;

export interface ChatControllerOptions {
  readonly context: vscode.ExtensionContext;
  readonly view: ChatView;
  readonly diff: PiDiffProvider;
}

/**
 * Orchestrates the whole extension: picks the workspace, supervises the engine,
 * translates webview intents into RPC commands, and feeds engine events into
 * the {@link ChatModel} that drives the UI.
 */
export class ChatController implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #view: ChatView;
  readonly #diff: PiDiffProvider;
  readonly #model: ChatModel;
  readonly #registry: EngineRegistry;
  readonly #output: vscode.OutputChannel;
  readonly #providers: ProviderService;
  readonly #disposables: vscode.Disposable[] = [];

  #activeWorkspace: string | undefined;
  #engine: EngineInstance | undefined;
  #launch: PiLaunch | undefined;
  #starting: Promise<void> | undefined;
  #trustRequired = false;
  #trustDecision: boolean | null = null;
  #trustDecided = true;
  #dialogQueue: ExtensionUiRequest[] = [];
  #activeDialog: string | undefined;
  #oauthAbort: AbortController | undefined;
  #oauthPromptResolve: ((value: string | null) => void) | undefined;
  #disposed = false;

  constructor(options: ChatControllerOptions) {
    this.#context = options.context;
    this.#view = options.view;
    this.#diff = options.diff;
    this.#output = vscode.window.createOutputChannel("pi");
    this.#providers = new ProviderService({
      getAgentDir: () => getAgentDir(),
      getLaunch: () => this.#launch,
      openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
      log: (message) => this.#log(message),
    });
    this.#model = new ChatModel({ emit: (message) => this.#view.post(message) });

    this.#registry = new EngineRegistry({
      reapIntervalMs: 60_000,
      create: (workspace) =>
        new EngineInstance({
          workspace,
          start: () => this.#spawn(workspace),
          idleTimeoutMs: this.#idleTimeoutMs(),
          onEvent: (message) => this.#onEngineEvent(workspace, message),
          onStatusChange: (status) => this.#onEngineStatus(workspace, status),
          onExtensionUiRequest: (request) => this.#onExtensionUiRequest(request),
          onWarning: (error) => this.#log(`protocol warning: ${error.message}`),
        }),
    });

    this.#model.setMeta({
      showThinking: this.#config().get<boolean>("showThinking", true),
      engine: "idle",
    });

    this.#disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.#onWorkspaceChanged()),
      vscode.workspace.onDidChangeConfiguration((event) => this.#onConfigurationChanged(event)),
      this.#output,
    );
  }

  dispose(): void {
    this.#disposed = true;
    void this.#registry.stopAll();
    this.#registry.dispose();
    for (const disposable of this.#disposables) disposable.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Webview plumbing                                                    */
  /* ------------------------------------------------------------------ */

  async onViewReady(): Promise<void> {
    this.#model.emitFullState();
    await this.ensureEngine();
    void this.#publishFiles();
    void this.#refreshCommands();
    void this.#publishProviders();
  }

  /** Command-palette entry points. */
  async newSession(): Promise<void> {
    await this.#dispatch({ type: "newSession" });
  }

  async openProviders(): Promise<void> {
    await this.#ensureLaunch();
    await this.#view.reveal();
    this.#view.post({ type: "openProviders" });
    await this.#publishProviders();
  }

  async abort(): Promise<void> {
    await this.#dispatch({ type: "abort" });
  }

  async restart(): Promise<void> {
    await this.#restartEngine();
  }

  showLogs(): void {
    this.#output.show(true);
  }

  /** Add a file/selection reference to the composer from an editor command. */
  async attach(attachment: Attachment): Promise<void> {
    this.#view.post({ type: "attach", attachment });
    await this.#view.reveal();
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      await this.#dispatch(message);
    } catch (error) {
      this.#model.addNote("error", `Command failed: ${describeError(error)}`);
    }
  }

  async #dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.onViewReady();
        break;
      case "prompt":
        await this.#sendPrompt(message.text, message.mode, message.attachments);
        break;
      case "abort":
        await this.#withEngine(async (engine) => {
          await engine.abort();
        });
        this.#model.setMeta({ isStreaming: false });
        break;
      case "newSession":
        await this.#withEngine(async (engine) => {
          await engine.newSession();
          this.#model.reset();
          await this.#refreshAll();
        });
        break;
      case "switchSession":
        await this.#withEngine(async (engine) => {
          const result = await engine.switchSession(message.path);
          if (result.cancelled) {
            this.#model.addNote("warn", "Session switch was cancelled by an extension.");
            return;
          }
          this.#model.reset();
          await this.#refreshAll();
        });
        break;
      case "deleteSession":
        await this.#deleteSession(message.path);
        break;
      case "renameSession":
        await this.#withEngine(async (engine) => {
          await engine.setSessionName(message.name);
          await this.#refreshState();
          await this.#refreshSessions();
        });
        break;
      case "fork":
        await this.#withEngine(async (engine) => {
          const result = await engine.fork(message.entryId);
          if (result.cancelled) {
            this.#model.addNote("warn", "Fork was cancelled by an extension.");
            return;
          }
          this.#model.reset();
          await this.#refreshAll();
        });
        break;
      case "setModel":
        await this.#withEngine(async (engine) => {
          await engine.setModel(message.provider, message.modelId);
          await this.#refreshState();
          await this.#refreshStats();
        });
        break;
      case "setThinking":
        await this.#withEngine(async (engine) => {
          await engine.setThinkingLevel(message.level);
          await this.#refreshState();
        });
        break;
      case "refresh":
        await this.#refreshAll();
        break;
      case "requestFiles":
        await this.#publishFiles();
        break;
      case "requestProviders":
        await this.#ensureLaunch();
        await this.#publishProviders();
        break;
      case "addApiKey":
        await this.#addApiKey(message.provider, message.key, message.baseUrl);
        break;
      case "addCustomProvider":
        await this.#addCustomProvider(message);
        break;
      case "removeCredential":
        await this.#removeCredential(message.provider);
        break;
      case "oauthLogin":
        await this.#oauthLogin(message.provider);
        break;
      case "oauthCancel":
        this.#cancelOAuth();
        break;
      case "oauthPromptResponse":
        this.#answerOAuthPrompt(message.value);
        break;
      case "dialogResponse":
        this.#respondDialog(message.id, message.response);
        break;
      case "openDiff":
        await this.#openDiff(message.id);
        break;
      case "openFile":
        await this.#openFile(message.path, message.line);
        break;
      case "restartEngine":
        await this.#restartEngine();
        break;
      case "openLogs":
        this.#output.show(true);
        break;
      case "trust":
        await this.#decideTrust(message.decision);
        break;
      case "retry":
        await this.#sendPrompt(message.text, "send", []);
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Engine lifecycle                                                    */
  /* ------------------------------------------------------------------ */

  async ensureEngine(): Promise<void> {
    const workspace = this.#workspaceFolder();
    if (workspace === undefined) {
      this.#model.setMeta({
        engine: "idle",
        engineError: "Open a folder to start pi.",
        workspace: null,
        workspaceName: null,
      });
      return;
    }
    if (this.#engine?.status === "ready" && this.#activeWorkspace === workspace) return;
    if (this.#starting !== undefined) return this.#starting;
    this.#starting = this.#startEngine(workspace).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #startEngine(workspace: string): Promise<void> {
    this.#activeWorkspace = workspace;
    const config = this.#config();
    const approveSetting = config.get<boolean>("approveProjectResources", false);

    this.#trustRequired = needsTrust(workspace);
    this.#trustDecision = readTrustDecision(getAgentDir(), workspace);
    this.#trustDecided = !this.#trustRequired || approveSetting || this.#trustDecision !== null;

    this.#model.setMeta({
      workspace,
      workspaceName: basename(workspace),
      trust: { required: this.#trustRequired, decided: this.#trustDecided, workspace },
      engineError: undefined,
    });

    if (!this.#trustDecided) {
      this.#model.setMeta({ engine: "idle" });
      this.#log(`workspace requires a trust decision: ${workspace}`);
      return;
    }

    this.#model.setMeta({ engine: "starting" });
    try {
      this.#launch = await locatePi({
        executablePath: config.get<string>("executablePath", ""),
        workspace,
        extensionPath: this.#context.extensionPath,
      });
      this.#log(`using pi (${this.#launch.source}): ${this.#launch.describe}`);
    } catch (error) {
      this.#failEngine(error);
      return;
    }

    const engine = this.#registry.ensure(workspace);
    this.#engine = engine;
    try {
      await engine.start();
    } catch (error) {
      this.#failEngine(error);
      return;
    }

    this.#model.setMeta({
      engine: "ready",
      engineError: undefined,
      ...(this.#launch.version !== undefined ? { piVersion: this.#launch.version } : {}),
    });
    await this.#refreshAll();
  }

  async #restartEngine(): Promise<void> {
    const workspace = this.#activeWorkspace;
    if (workspace !== undefined) await this.#registry.stop(workspace);
    this.#engine = undefined;
    await this.ensureEngine();
  }

  async #onWorkspaceChanged(): Promise<void> {
    const workspace = this.#workspaceFolder();
    if (workspace === this.#activeWorkspace) return;
    await this.#registry.stopAll();
    this.#engine = undefined;
    this.#model.reset();
    await this.ensureEngine();
  }

  #onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration("pi")) return;
    const config = this.#config();
    this.#model.setShowThinking(config.get<boolean>("showThinking", true));
    const engineAffecting = [
      "pi.executablePath",
      "pi.extraArgs",
      "pi.tools",
      "pi.excludeTools",
      "pi.approveProjectResources",
      "pi.engineIdleTimeoutMinutes",
    ];
    if (engineAffecting.some((key) => event.affectsConfiguration(key))) {
      void this.#restartEngine();
    }
  }

  #spawn(workspace: string): ReturnType<typeof spawnPiEngine> {
    const launch = this.#launch;
    if (launch === undefined) throw new Error("pi CLI has not been located yet");
    return spawnPiEngine({
      command: launch.command,
      args: launch.args,
      cwd: workspace,
      env: launch.env,
      extraArgs: this.#engineArgs(workspace),
    });
  }

  #engineArgs(workspace: string): string[] {
    const config = this.#config();
    const args: string[] = [];
    const tools = config.get<string>("tools", "").trim();
    if (tools.length > 0) args.push("--tools", tools);
    const exclude = config.get<string>("excludeTools", "").trim();
    if (exclude.length > 0) args.push("--exclude-tools", exclude);
    args.push(...(config.get<string[]>("extraArgs", []) ?? []));

    if (config.get<boolean>("approveProjectResources", false)) {
      args.push("--approve");
    } else if (this.#trustRequired && this.#activeWorkspace === workspace) {
      args.push(this.#trustDecision === true ? "--approve" : "--no-approve");
    }
    return args;
  }

  #onEngineStatus(workspace: string, status: EngineStatus): void {
    if (workspace !== this.#activeWorkspace) return;
    if (status === "crashed") {
      const stderr = this.#engine?.stderrTail.trim();
      const engineError =
        stderr !== undefined && stderr.length > 0 ? stderr.slice(-4000) : "The pi engine exited unexpectedly.";
      this.#log(`engine crashed: ${engineError}`);
      this.#model.setMeta({ engine: status, engineError, isStreaming: false });
      return;
    }
    this.#model.setMeta({ engine: status });
  }

  #onEngineEvent(workspace: string, message: unknown): void {
    if (workspace !== this.#activeWorkspace) return;
    this.#model.applyEvent(message);
    const type = (message as { type?: unknown }).type;
    // `turn_end` fires between turns of a multi-turn run; refreshing state here
    // would briefly flip the UI back to idle, so only stats are refreshed.
    if (type === "turn_end" || type === "compaction_end") {
      void this.#refreshStats();
    }
    if (type === "agent_settled") {
      void this.#refreshState();
      void this.#refreshStats();
      void this.#refreshSessions();
      void this.#refreshCommands();
      void this.#refreshForkEntryIds();
    }
  }

  async #refreshForkEntryIds(): Promise<void> {
    const engine = this.#engine;
    if (engine?.status !== "ready") return;
    this.#model.attachForkEntryIds(await engine.getForkMessages());
  }

  #failEngine(error: unknown): void {
    const detail = describeError(error);
    this.#model.setMeta({ engine: "crashed", engineError: detail, isStreaming: false });
    this.#model.addNote("error", detail);
    this.#log(detail);
  }

  async #withEngine(action: (engine: EngineInstance) => Promise<void>): Promise<void> {
    if (this.#engine?.status !== "ready") await this.ensureEngine();
    const engine = this.#engine;
    if (engine === undefined || engine.status !== "ready") {
      this.#model.addNote("warn", "The pi engine is not running. Check the output panel for details.");
      return;
    }
    await action(engine);
  }

  /* ------------------------------------------------------------------ */
  /* Refresh                                                             */
  /* ------------------------------------------------------------------ */

  async #refreshAll(): Promise<void> {
    await Promise.all([
      this.#refreshState(),
      this.#refreshStats(),
      this.#refreshModels(),
      this.#refreshThinking(),
      this.#refreshHistory(),
      this.#refreshSessions(),
      this.#refreshCommands(),
    ]);
  }

  async #refreshState(): Promise<void> {
    const engine = this.#engine;
    if (engine?.status !== "ready") return;
    const state = await engine.getState();
    if (state === undefined) return;
    this.#model.setMeta({
      isStreaming: state["isStreaming"] === true,
      isCompacting: state["isCompacting"] === true,
      thinkingLevel: str(state["thinkingLevel"]) ?? "medium",
      sessionName: str(state["sessionName"]) ?? null,
      sessionFile: str(state["sessionFile"]) ?? null,
      model: toModelInfo(state["model"]),
    });
  }

  async #refreshStats(): Promise<void> {
    const engine = this.#engine;
    if (engine?.status !== "ready") return;
    const stats = await engine.getSessionStats();
    this.#model.setMeta({ stats: toUsageStats(stats) });
  }

  async #refreshModels(): Promise<void> {
    const engine = this.#engine;
    if (engine?.status !== "ready") return;
    const models = await engine.listModels();
    const infos = models.map(toModelInfo).filter((model) => model !== null);
    this.#model.setMeta({ models: infos });
  }

  async #refreshThinking(): Promise<void> {
    const engine = this.#engine;
    if (engine?.status !== "ready") return;
    this.#model.setMeta({ thinkingLevels: await engine.listThinkingLevels() });
  }

  async #refreshHistory(): Promise<void> {
    const engine = this.#engine;
    if (engine?.status !== "ready") return;
    const [messages, forks] = await Promise.all([engine.getMessages(), engine.getForkMessages()]);
    this.#model.setHistory(messages, forks);
  }

  async #refreshSessions(): Promise<void> {
    const workspace = this.#activeWorkspace;
    if (workspace === undefined) return;
    this.#model.setMeta({ sessions: await listSessions(getAgentDir(), workspace) });
  }

  async #refreshCommands(): Promise<void> {
    const engine = this.#engine;
    if (engine?.status !== "ready") return;
    const commands = await engine.getCommands();
    const mapped: SlashCommand[] = [];
    for (const command of commands) {
      const name = str(command["name"]);
      if (name === undefined) continue;
      mapped.push({
        name,
        ...(str(command["description"]) !== undefined ? { description: str(command["description"]) } : {}),
        ...(str(command["source"]) !== undefined ? { source: str(command["source"]) } : {}),
      });
    }
    this.#view.post({ type: "commands", commands: mapped });
  }

  async #publishFiles(): Promise<void> {
    const workspace = this.#activeWorkspace ?? this.#workspaceFolder();
    if (workspace === undefined) return;
    try {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,out,build,.next,target,vendor}/**",
        MAX_FILE_INDEX,
      );
      const files = uris
        .map((uri) => toPosix(relative(workspace, uri.fsPath)))
        .filter((path) => path.length > 0 && !path.startsWith(".."))
        .sort();
      this.#view.post({ type: "files", files });
    } catch (error) {
      this.#log(`failed to index workspace files: ${describeError(error)}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Prompting                                                           */
  /* ------------------------------------------------------------------ */

  async #sendPrompt(
    text: string,
    mode: "send" | "steer" | "followUp",
    attachments: readonly Attachment[],
  ): Promise<void> {
    if (this.#engine?.status !== "ready") await this.ensureEngine();
    const engine = this.#engine;
    if (engine === undefined || engine.status !== "ready") {
      this.#model.addNote("warn", "Cannot send: the pi engine is not running.");
      return;
    }

    const trimmed = text.trim();
    const hydrated = await Promise.all(attachments.map((attachment) => this.#hydrate(attachment)));
    if (trimmed.length === 0 && hydrated.length === 0) return;

    this.#model.addUserMessage(trimmed, hydrated);
    const images = hydrated
      .filter((attachment) => attachment.kind === "image" && attachment.text !== undefined)
      .map((attachment) => ({
        type: "image" as const,
        data: attachment.text ?? "",
        mimeType: attachment.mimeType ?? "image/png",
      }));

    const composed = composePrompt(trimmed, hydrated);
    const effectiveMode = mode === "send" && this.#model.meta.isStreaming ? "steer" : mode;
    this.#model.setMeta({ isStreaming: true });

    try {
      if (effectiveMode === "steer") await engine.steer(composed);
      else if (effectiveMode === "followUp") await engine.followUp(composed);
      else await engine.prompt(composed, { images });
    } catch (error) {
      this.#model.setMeta({ isStreaming: false });
      this.#model.addNote("error", `Failed to send prompt: ${describeError(error)}`);
    }
  }

  /** Fill in file contents for attachments the webview only knows by path. */
  async #hydrate(attachment: Attachment): Promise<Attachment> {
    if (attachment.kind !== "file" || attachment.text !== undefined) return attachment;
    const workspace = this.#activeWorkspace ?? this.#workspaceFolder();
    if (workspace === undefined) return attachment;
    const absolute = isAbsolute(attachment.path) ? attachment.path : resolve(workspace, attachment.path);
    try {
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) return { ...attachment, text: "(binary file omitted)" };
      const content = buffer.toString("utf8");
      const text =
        content.length > MAX_ATTACHMENT_CHARS
          ? `${content.slice(0, MAX_ATTACHMENT_CHARS)}\n… (truncated)`
          : content;
      return { ...attachment, text };
    } catch (error) {
      return { ...attachment, text: `(could not read file: ${describeError(error)})` };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Providers & model sources                                           */
  /* ------------------------------------------------------------------ */

  async #publishProviders(): Promise<void> {
    try {
      const providers = await this.#providers.list();
      this.#view.post({
        type: "providers",
        providers,
        oauthAvailable: this.#providers.oauthAvailable,
      });
    } catch (error) {
      this.#view.post({ type: "providerStatus", ok: false, message: describeError(error), busy: false });
    }
  }

  /** Locate pi even before an engine exists, so credentials can be validated. */
  async #ensureLaunch(): Promise<void> {
    if (this.#launch !== undefined) return;
    const workspace = this.#activeWorkspace ?? this.#workspaceFolder();
    if (workspace === undefined) return;
    try {
      this.#launch = await locatePi({
        executablePath: this.#config().get<string>("executablePath", ""),
        workspace,
        extensionPath: this.#context.extensionPath,
      });
    } catch (error) {
      this.#log(`could not locate pi for provider checks: ${describeError(error)}`);
    }
  }

  async #addApiKey(provider: string, key: string, baseUrl?: string): Promise<void> {
    this.#view.post({ type: "providerStatus", ok: true, message: `Saving ${provider}…`, busy: true });
    await this.#ensureLaunch();
    try {
      const result = await this.#providers.addApiKey(provider, key, baseUrl);
      this.#view.post({ type: "providerStatus", ok: result.ok, message: result.message, busy: false });
      await this.#afterProviderChange();
    } catch (error) {
      this.#view.post({ type: "providerStatus", ok: false, message: describeError(error), busy: false });
    }
  }

  async #addCustomProvider(message: {
    readonly id: string;
    readonly api: string;
    readonly baseUrl: string;
    readonly key: string;
    readonly models: readonly string[];
  }): Promise<void> {
    this.#view.post({ type: "providerStatus", ok: true, message: `Saving ${message.id}…`, busy: true });
    await this.#ensureLaunch();
    try {
      const result = await this.#providers.addCustomProvider({
        id: message.id,
        api: message.api as Parameters<ProviderService["addCustomProvider"]>[0]["api"],
        baseUrl: message.baseUrl,
        key: message.key,
        models: message.models,
      });
      this.#view.post({ type: "providerStatus", ok: result.ok, message: result.message, busy: false });
      await this.#afterProviderChange();
    } catch (error) {
      this.#view.post({ type: "providerStatus", ok: false, message: describeError(error), busy: false });
    }
  }

  async #removeCredential(provider: string): Promise<void> {
    try {
      const result = await this.#providers.remove(provider);
      this.#view.post({ type: "providerStatus", ok: result.ok, message: result.message, busy: false });
      await this.#afterProviderChange();
    } catch (error) {
      this.#view.post({ type: "providerStatus", ok: false, message: describeError(error), busy: false });
    }
  }

  /** Restart the engine so it picks up new credentials/models, then refresh. */
  async #afterProviderChange(): Promise<void> {
    await this.#publishProviders();
    if (this.#activeWorkspace !== undefined) {
      await this.#restartEngine();
      await this.#refreshModels();
      await this.#refreshState();
    }
  }

  async #oauthLogin(provider: string): Promise<void> {
    if (this.#oauthAbort !== undefined) return;
    await this.#ensureLaunch();
    const controller = new AbortController();
    this.#oauthAbort = controller;
    this.#view.post({ type: "providerStatus", ok: true, message: `Starting ${provider} sign-in…`, busy: true });
    try {
      const result = await this.#providers.login(
        provider as OAuthProviderId,
        {
          prompt: (view) => this.#askOAuthPrompt(view),
          event: (event) => {
            if (event.kind === "auth_url") this.#providers.openExternal(event.url);
            else if (event.kind === "device_code") this.#providers.openExternal(event.verificationUri);
            this.#view.post({ type: "oauthEvent", event });
          },
        },
        controller.signal,
      );
      this.#view.post({ type: "providerStatus", ok: result.ok, message: result.message, busy: false });
      await this.#afterProviderChange();
    } catch (error) {
      this.#view.post({ type: "providerStatus", ok: false, message: describeError(error), busy: false });
    } finally {
      this.#oauthAbort = undefined;
      this.#oauthPromptResolve = undefined;
      this.#view.post({ type: "oauthPrompt", prompt: null });
    }
  }

  #askOAuthPrompt(view: OAuthPromptView): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.#oauthPromptResolve = (value) => {
        if (value === null) reject(new Error("Sign-in cancelled."));
        else resolve(value);
      };
      this.#view.post({ type: "oauthPrompt", prompt: view });
    });
  }

  #answerOAuthPrompt(value: string | null): void {
    const resolve = this.#oauthPromptResolve;
    this.#oauthPromptResolve = undefined;
    this.#view.post({ type: "oauthPrompt", prompt: null });
    resolve?.(value);
  }

  #cancelOAuth(): void {
    this.#oauthAbort?.abort();
    this.#answerOAuthPrompt(null);
    this.#oauthAbort = undefined;
    this.#view.post({ type: "providerStatus", ok: false, message: "Sign-in cancelled.", busy: false });
  }

  /* ------------------------------------------------------------------ */
  /* Sessions, files, dialogs                                            */
  /* ------------------------------------------------------------------ */

  async #deleteSession(sessionPath: string): Promise<void> {
    const workspace = this.#activeWorkspace;
    if (workspace === undefined) return;
    const result = await deleteSession(getAgentDir(), workspace, sessionPath);
    if (!result.ok) {
      this.#model.addNote("error", `Could not delete session: ${result.error ?? "unknown error"}`);
      return;
    }
    await this.#refreshSessions();
  }

  async #openDiff(itemId: string): Promise<void> {
    const item = this.#model.findItem(itemId);
    if (item?.kind !== "tool" || item.diff === undefined) return;
    const uri = this.#diff.create(item.diff, item.name);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async #openFile(path: string, line?: number): Promise<void> {
    const workspace = this.#activeWorkspace ?? this.#workspaceFolder();
    if (workspace === undefined) return;
    const absolute = isAbsolute(path) ? path : resolve(workspace, path);
    const uri = vscode.Uri.file(absolute);
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (line !== undefined) {
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      options.selection = new vscode.Range(position, position);
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, options);
    } catch (error) {
      this.#model.addNote("warn", `Could not open ${path}: ${describeError(error)}`);
    }
  }

  async #decideTrust(decision: "always" | "never"): Promise<void> {
    const workspace = this.#activeWorkspace ?? this.#workspaceFolder();
    if (workspace === undefined) return;
    const trusted = decision === "always";
    writeTrustDecision(getAgentDir(), workspace, trusted);
    this.#trustDecision = trusted;
    this.#trustDecided = true;
    this.#model.setMeta({
      trust: { required: this.#trustRequired, decided: true, workspace },
    });
    if (!trusted) {
      this.#model.addNote("info", "Project-local pi resources will not be loaded for this workspace.");
    }
    await this.ensureEngine();
  }

  #onExtensionUiRequest(request: ExtensionUiRequest): void {
    const method = request.method;
    if (method === "notify") {
      const level = notifyLevel(str(request["notifyType"]));
      this.#model.addNote(level, str(request["message"]) ?? "");
      return;
    }
    if (method === "set_editor_text") {
      const text = str(request["text"]);
      if (text !== undefined) this.#view.post({ type: "setDraft", text });
      return;
    }
    if (isDialogUiMethod(method)) {
      this.#dialogQueue.push(request);
      this.#showNextDialog();
      return;
    }
    this.#log(`ignoring extension UI method: ${method}`);
  }

  #showNextDialog(): void {
    if (this.#activeDialog !== undefined) return;
    const request = this.#dialogQueue.shift();
    if (request === undefined) {
      this.#view.post({ type: "dialog", dialog: null });
      return;
    }
    this.#activeDialog = request.id;
    this.#view.post({ type: "dialog", dialog: toDialogRequest(request) });
  }

  #respondDialog(id: string, response: Record<string, unknown>): void {
    if (this.#activeDialog === id) {
      this.#activeDialog = undefined;
      this.#view.post({ type: "dialog", dialog: null });
    }
    this.#engine?.respondExtensionUi(id, response);
    this.#showNextDialog();
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  #workspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  #config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("pi");
  }

  #idleTimeoutMs(): number {
    const minutes = this.#config().get<number>("engineIdleTimeoutMinutes", 30);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
  }

  #log(message: string): void {
    if (this.#disposed) return;
    this.#output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

/* -------------------------------------------------------------------- */
/* Free functions                                                        */
/* -------------------------------------------------------------------- */

function composePrompt(text: string, attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return text;
  const parts: string[] = [];
  if (text.length > 0) parts.push(text);
  for (const attachment of attachments) {
    if (attachment.kind === "file") {
      parts.push(`<file path="${attachment.path}">\n${attachment.text ?? ""}\n</file>`);
    } else if (attachment.kind === "selection") {
      const lines =
        attachment.startLine !== undefined && attachment.endLine !== undefined
          ? ` lines="${attachment.startLine}-${attachment.endLine}"`
          : "";
      parts.push(`<selection path="${attachment.path}"${lines}>\n${attachment.text ?? ""}\n</selection>`);
    }
  }
  return parts.join("\n\n");
}

function toDialogRequest(request: ExtensionUiRequest): DialogRequest {
  const options = Array.isArray(request["options"])
    ? (request["options"] as unknown[])
        .map(toDialogOption)
        .filter((option): option is DialogOption => option !== undefined)
    : undefined;
  const prefill = str(request["prefill"]) ?? str(request["value"]);
  return {
    id: request.id,
    method: request.method as DialogRequest["method"],
    ...(str(request["title"]) !== undefined ? { title: str(request["title"]) } : {}),
    ...(str(request["message"]) !== undefined ? { message: str(request["message"]) } : {}),
    ...(options !== undefined && options.length > 0 ? { options } : {}),
    ...(str(request["placeholder"]) !== undefined ? { placeholder: str(request["placeholder"]) } : {}),
    ...(prefill !== undefined ? { defaultValue: prefill } : {}),
  };
}

function toDialogOption(value: unknown): DialogOption | undefined {
  if (typeof value === "string") return { id: value, label: value };
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const label = str(record["label"]) ?? str(record["value"]);
  if (label === undefined) return undefined;
  return {
    id: str(record["id"]) ?? str(record["value"]) ?? label,
    label,
    ...(str(record["description"]) !== undefined ? { description: str(record["description"]) } : {}),
  };
}

function notifyLevel(value: string | undefined): NoteLevel {
  if (value === "warning") return "warn";
  if (value === "error") return "error";
  return "info";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
