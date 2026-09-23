import type {
  ChatItem,
  DialogRequest,
  HostMessage,
  Meta,
  OAuthEventView,
  OAuthPromptView,
  PluginInfo,
  ProviderInfo,
  SkillInfo,
  SlashCommand,
} from "../../src/shared/protocol";
import { EMPTY_META } from "../../src/shared/protocol";

export interface Toast {
  readonly id: string;
  readonly level: "info" | "warn" | "error" | "success";
  readonly message: string;
}

export interface ProviderStatus {
  readonly ok: boolean;
  readonly message: string;
  readonly busy: boolean;
}

export interface State {
  readonly meta: Meta;
  readonly items: readonly ChatItem[];
  readonly dialog: DialogRequest | null;
  readonly files: readonly string[];
  readonly commands: readonly SlashCommand[];
  readonly toasts: readonly Toast[];
  readonly providers: readonly ProviderInfo[];
  readonly oauthAvailable: boolean;
  readonly providersOpen: boolean;
  readonly providerStatus: ProviderStatus | null;
  readonly oauthPrompt: OAuthPromptView | null;
  readonly oauthMessage: string | null;
  readonly skills: readonly SkillInfo[];
  readonly skillsLoaded: boolean;
  readonly plugins: readonly PluginInfo[];
  readonly pluginsLoaded: boolean;
  readonly capabilitiesOpen: boolean;
  readonly capabilitiesTab: "skills" | "plugins";
}

export type EffectMessage = Extract<
  HostMessage,
  { type: "attach" | "setDraft" | "insert" | "focus" }
>;

type Listener = () => void;
type EffectListener = (message: EffectMessage) => void;

const INITIAL: State = {
  meta: EMPTY_META,
  items: [],
  dialog: null,
  files: [],
  commands: [],
  toasts: [],
  providers: [],
  oauthAvailable: false,
  providersOpen: false,
  providerStatus: null,
  oauthPrompt: null,
  oauthMessage: null,
  skills: [],
  skillsLoaded: false,
  plugins: [],
  pluginsLoaded: false,
  capabilitiesOpen: false,
  capabilitiesTab: "skills",
};

/** Minimal external store consumed through `useSyncExternalStore`. */
export class Store {
  #state: State = INITIAL;
  readonly #listeners = new Set<Listener>();
  readonly #effectListeners = new Set<EffectListener>();
  #toastCounter = 0;

  getState = (): State => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  subscribeEffects = (listener: EffectListener): (() => void) => {
    this.#effectListeners.add(listener);
    return () => this.#effectListeners.delete(listener);
  };

  dispatch(message: HostMessage): void {
    switch (message.type) {
      case "state":
        this.#set({ ...this.#state, ...message.state });
        return;
      case "items":
        this.#set({ ...this.#state, items: message.items });
        return;
      case "item":
        this.#set({ ...this.#state, items: upsert(this.#state.items, message.item) });
        return;
      case "delta":
        this.#set({ ...this.#state, items: applyDelta(this.#state.items, message) });
        return;
      case "meta":
        this.#set({ ...this.#state, meta: message.meta });
        return;
      case "dialog":
        this.#set({ ...this.#state, dialog: message.dialog });
        return;
      case "files":
        this.#set({ ...this.#state, files: message.files });
        return;
      case "commands":
        this.#set({ ...this.#state, commands: message.commands });
        return;
      case "skills":
        this.#set({ ...this.#state, skills: message.skills, skillsLoaded: true });
        return;
      case "plugins":
        this.#set({ ...this.#state, plugins: message.plugins, pluginsLoaded: true });
        return;
      case "providers":
        this.#set({
          ...this.#state,
          providers: message.providers,
          oauthAvailable: message.oauthAvailable,
        });
        return;
      case "providerStatus":
        this.#set({
          ...this.#state,
          providerStatus: { ok: message.ok, message: message.message, busy: message.busy },
        });
        return;
      case "oauthPrompt":
        this.#set({ ...this.#state, oauthPrompt: message.prompt });
        return;
      case "oauthEvent":
        this.#set({ ...this.#state, oauthMessage: describeOAuthEvent(message.event) });
        return;
      case "openProviders":
        this.#set({ ...this.#state, providersOpen: true });
        return;
      case "notice":
        this.#toast(message.level, message.message);
        return;
      case "attach":
      case "setDraft":
      case "insert":
      case "focus":
        for (const listener of this.#effectListeners) listener(message);
        return;
      default:
        return;
    }
  }

  dismissToast(id: string): void {
    this.#set({ ...this.#state, toasts: this.#state.toasts.filter((toast) => toast.id !== id) });
  }

  setProvidersOpen(open: boolean): void {
    this.#set({
      ...this.#state,
      providersOpen: open,
      ...(open ? {} : { oauthPrompt: null, oauthMessage: null }),
    });
  }

  openCapabilities(tab: "skills" | "plugins"): void {
    this.#set({ ...this.#state, capabilitiesOpen: true, capabilitiesTab: tab });
  }

  setCapabilitiesTab(tab: "skills" | "plugins"): void {
    this.#set({ ...this.#state, capabilitiesTab: tab });
  }

  closeCapabilities(): void {
    this.#set({ ...this.#state, capabilitiesOpen: false });
  }

  #toast(level: Toast["level"], message: string): void {
    this.#toastCounter += 1;
    const id = `toast-${this.#toastCounter}`;
    this.#set({ ...this.#state, toasts: [...this.#state.toasts, { id, level, message }] });
    window.setTimeout(() => this.dismissToast(id), 6000);
  }

  #set(next: State): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

function upsert(items: readonly ChatItem[], item: ChatItem): readonly ChatItem[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

function describeOAuthEvent(event: OAuthEventView): string {
  switch (event.kind) {
    case "auth_url":
      return event.instructions !== undefined && event.instructions.length > 0
        ? `${event.instructions} (opening the browser… )`
        : "Opening the browser to sign in…";
    case "device_code":
      return `Enter code ${event.userCode} at ${event.verificationUri}`;
    case "progress":
      return event.message;
    default:
      return event.message;
  }
}

function applyDelta(
  items: readonly ChatItem[],
  message: Extract<HostMessage, { type: "delta" }>,
): readonly ChatItem[] {
  const index = items.findIndex((entry) => entry.id === message.id);
  if (index === -1) return items;
  const current = items[index];
  if (current === undefined) return items;
  const next = items.slice();

  if (message.field === "text" && current.kind === "assistant") {
    next[index] = { ...current, text: current.text + message.delta };
  } else if (message.field === "thinking" && current.kind === "assistant") {
    next[index] = { ...current, thinking: current.thinking + message.delta };
  } else if (message.field === "output" && current.kind === "tool") {
    next[index] = { ...current, output: current.output + message.delta };
  } else if (message.field === "output" && current.kind === "bash") {
    next[index] = { ...current, output: current.output + message.delta };
  } else if (message.field === "argsText" && current.kind === "tool") {
    next[index] = { ...current, argsText: `${current.argsText ?? ""}${message.delta}` };
  } else {
    return items;
  }
  return next;
}
