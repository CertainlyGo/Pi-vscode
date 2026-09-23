import type { JSX } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Attachment, ChatItem, PromptMode } from "../../src/shared/protocol";
import { post } from "./vscode";
import type { Store } from "./store";
import { Composer } from "./components/Composer";
import { DialogHost } from "./components/DialogHost";
import { Icon } from "./components/Icons";
import { MessageItem } from "./components/MessageItem";
import { OAuthDialog } from "./components/OAuthDialog";
import { SessionPicker } from "./components/Pickers";
import { ProvidersSheet } from "./components/ProvidersSheet";
import { Toasts } from "./components/Toasts";
import { ToolCard } from "./components/ToolCard";
import { UsageBar } from "./components/UsageBar";

export interface AppProps {
  readonly store: Store;
}

export function App({ store }: AppProps): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const {
    meta,
    items,
    dialog,
    files,
    commands,
    toasts,
    providers,
    oauthAvailable,
    providersOpen,
    providerStatus,
    oauthPrompt,
    oauthMessage,
  } = state;

  const streamRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    post({ type: "ready" });
  }, []);

  useEffect(() => {
    const element = streamRef.current;
    if (element === null) return;
    if (atBottom) element.scrollTop = element.scrollHeight;
  }, [items, atBottom]);

  const onScroll = (): void => {
    const element = streamRef.current;
    if (element === null) return;
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
  };

  const scrollToBottom = (): void => {
    const element = streamRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    setAtBottom(true);
  };

  const statusLabel = useMemo(() => describeStatus(meta), [meta]);

  const onFork = useCallback((entryId: string) => post({ type: "fork", entryId }), []);
  const onOpenFile = useCallback(
    (path: string, line?: number) => post({ type: "openFile", path, ...(line !== undefined ? { line } : {}) }),
    [],
  );
  const onOpenDiff = useCallback((id: string) => post({ type: "openDiff", id }), []);
  const onSend = useCallback(
    (text: string, mode: PromptMode, attachments: readonly Attachment[]) =>
      post({ type: "prompt", text, mode, attachments }),
    [],
  );
  const onAbort = useCallback(() => post({ type: "abort" }), []);
  const onCompact = useCallback(() => post({ type: "compact" }), []);
  const onSetModel = useCallback(
    (provider: string, modelId: string) => post({ type: "setModel", provider, modelId }),
    [],
  );
  const onSetThinking = useCallback((level: string) => post({ type: "setThinking", level }), []);
  const onManageProviders = useCallback(() => {
    post({ type: "requestProviders" });
    store.setProvidersOpen(true);
  }, [store]);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="brand" title="pi">
            <Icon name="sparkle" size={15} />
          </span>
          <SessionPicker
            meta={meta}
            onSwitch={(path) => post({ type: "switchSession", path })}
            onDelete={(path) => post({ type: "deleteSession", path })}
            onRename={(name) => post({ type: "renameSession", name })}
          />
        </div>
        <div className="header-right">
          <span className={`engine-dot ${meta.engine}`} title={statusLabel} />
          <span className="engine-label">{statusLabel}</span>
          <button
            type="button"
            className="icon-btn"
            title="Providers & models"
            onClick={onManageProviders}
          >
            <Icon name="key" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="New session"
            onClick={() => post({ type: "newSession" })}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Restart engine"
            onClick={() => post({ type: "restartEngine" })}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button type="button" className="icon-btn" title="Show logs" onClick={() => post({ type: "openLogs" })}>
            <Icon name="terminal" size={14} />
          </button>
        </div>
      </header>

      <main className="stream" ref={streamRef} onScroll={onScroll}>
        <div className="stream-inner">
          {meta.trust.required && !meta.trust.decided && (
            <div className="banner trust">
              <div className="banner-text">
                <strong>Trust this workspace?</strong>
                <span>
                  This folder contains project-local pi resources (<code>.pi/</code>, skills or context files). They
                  run with your permissions.
                </span>
              </div>
              <div className="banner-actions">
                <button type="button" className="btn ghost" onClick={() => post({ type: "trust", decision: "never" })}>
                  Don't trust
                </button>
                <button type="button" className="btn primary" onClick={() => post({ type: "trust", decision: "always" })}>
                  Trust
                </button>
              </div>
            </div>
          )}

          {meta.engine === "crashed" && (
            <div className="banner error">
              <div className="banner-text">
                <strong>pi engine stopped</strong>
                <span>{meta.engineError ?? "The engine exited unexpectedly."}</span>
              </div>
              <div className="banner-actions">
                <button type="button" className="btn ghost" onClick={() => post({ type: "openLogs" })}>
                  Logs
                </button>
                <button type="button" className="btn primary" onClick={() => post({ type: "restartEngine" })}>
                  Restart
                </button>
              </div>
            </div>
          )}

          {meta.workspace === null && (
            <EmptyState
              title="Open a folder to get started"
              body="pi runs in your workspace, reads your files and edits them in place."
            />
          )}

          {meta.workspace !== null && items.length === 0 && meta.engine === "ready" && (
            <EmptyState
              title="What should we build?"
              body="Describe a task, or reference files with @ and commands with /."
              onExample={(text) => store.dispatch({ type: "setDraft", text })}
            />
          )}

          {items.map((item) => (
            <ItemView
              key={item.id}
              item={item}
              onFork={onFork}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ))}

          {meta.isCompacting && <div className="working">Compacting context…</div>}
        </div>

        {!atBottom && (
          <button type="button" className="scroll-bottom" onClick={scrollToBottom} title="Scroll to bottom">
            <Icon name="arrow-down" size={15} />
          </button>
        )}
      </main>

      <UsageBar meta={meta} onCompact={onCompact} />

      <Composer
        meta={meta}
        files={files}
        commands={commands}
        store={store}
        onSend={onSend}
        onAbort={onAbort}
        onSetModel={onSetModel}
        onSetThinking={onSetThinking}
      />

      <DialogHost dialog={dialog} onRespond={(id, response) => post({ type: "dialogResponse", id, response })} />
      {providersOpen && (
        <ProvidersSheet
          providers={providers}
          oauthAvailable={oauthAvailable}
          status={providerStatus}
          oauthMessage={oauthMessage}
          onClose={() => store.setProvidersOpen(false)}
          onAddApiKey={(provider, key, baseUrl) =>
            post({ type: "addApiKey", provider, key, ...(baseUrl !== undefined ? { baseUrl } : {}) })
          }
          onAddCustom={(input) => post({ type: "addCustomProvider", ...input })}
          onRemove={(provider) => post({ type: "removeCredential", provider })}
          onOAuthLogin={(provider) => post({ type: "oauthLogin", provider })}
          onOAuthCancel={() => post({ type: "oauthCancel" })}
        />
      )}
      <OAuthDialog
        prompt={oauthPrompt}
        onRespond={(value) => post({ type: "oauthPromptResponse", value })}
      />
      <Toasts toasts={toasts} onDismiss={(id) => store.dismissToast(id)} />
    </div>
  );
}

interface ItemViewProps {
  readonly item: ChatItem;
  readonly onFork: (entryId: string) => void;
  readonly onOpenFile: (path: string, line?: number) => void;
  readonly onOpenDiff: (id: string) => void;
}

const ItemView = memo(function ItemView({ item, onFork, onOpenFile, onOpenDiff }: ItemViewProps): JSX.Element {
  if (item.kind === "tool") {
    return <ToolCard item={item} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />;
  }
  return <MessageItem item={item} onFork={onFork} onOpenFile={onOpenFile} />;
});

function EmptyState({
  title,
  body,
  onExample,
}: {
  title: string;
  body: string;
  onExample?: (text: string) => void;
}): JSX.Element {
  const examples = [
    "Explain this codebase and its architecture",
    "Find and fix the failing tests",
    "Add input validation to the API layer",
  ];
  return (
    <div className="empty">
      <div className="empty-mark">
        <Icon name="sparkle" size={22} />
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
      {onExample !== undefined && (
        <div className="empty-examples">
          {examples.map((example) => (
            <button key={example} type="button" className="example" onClick={() => onExample(example)}>
              {example}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function describeStatus(meta: { engine: string; isStreaming: boolean; isCompacting: boolean }): string {
  if (meta.engine === "crashed") return "stopped";
  if (meta.engine === "starting") return "starting";
  if (meta.engine !== "ready") return "idle";
  if (meta.isCompacting) return "compacting";
  if (meta.isStreaming) return "working";
  return "ready";
}
