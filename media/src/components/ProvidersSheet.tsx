import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { ProviderInfo } from "../../../src/shared/protocol";
import {
  API_FORMATS,
  KNOWN_PROVIDERS,
  OAUTH_PROVIDERS,
  THINKING_LEVELS,
} from "../../../src/shared/provider-catalog";
import type { ApiFormat } from "../../../src/shared/provider-catalog";
import type { DiscoveryState, ProviderStatus } from "../store";
import { Icon } from "./Icons";

export interface ProvidersSheetProps {
  readonly providers: readonly ProviderInfo[];
  readonly oauthAvailable: boolean;
  readonly status: ProviderStatus | null;
  readonly oauthMessage: string | null;
  readonly discovered: DiscoveryState | null;
  readonly onClose: () => void;
  readonly onAddApiKey: (provider: string, key: string, baseUrl?: string) => void;
  readonly onAddCustom: (input: {
    readonly id: string;
    readonly api: ApiFormat;
    readonly baseUrl: string;
    readonly key: string;
    readonly models: readonly string[];
  }) => void;
  readonly onRemove: (provider: string) => void;
  readonly onDetect: (provider: string) => void;
  readonly onSetReasoning: (provider: string, modelId: string, reasoning: boolean) => void;
  readonly onSetThinking: (provider: string, modelId: string, level: string) => void;
  readonly onOAuthLogin: (provider: string) => void;
  readonly onOAuthCancel: () => void;
}

function summarizeModels(models: readonly string[]): string {
  if (models.length <= 4) return models.join(", ");
  return `${models.length} models — ${models.slice(0, 4).join(", ")}…`;
}

type Tab = "key" | "custom";

export function ProvidersSheet(props: ProvidersSheetProps): JSX.Element {
  const { status } = props;
  const busy = status?.busy === true;
  const [tab, setTab] = useState<Tab>("key");

  const [provider, setProvider] = useState(KNOWN_PROVIDERS[0]?.id ?? "openai");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const [newId, setNewId] = useState("");
  const [newApi, setNewApi] = useState<ApiFormat>("openai-completions");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newModels, setNewModels] = useState("");

  // Optimistic per-model edits while the host persists them.
  const [reasoningDraft, setReasoningDraft] = useState<Record<string, boolean>>({});
  const [levelDraft, setLevelDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setReasoningDraft({});
    setLevelDraft({});
  }, [props.discovered]);

  const discovered = props.discovered;
  const reasoningCount = discovered?.models.filter((model) => model.reasoning).length ?? 0;

  const saveApiKey = (): void => {
    if (provider.length === 0 || key.trim().length === 0) return;
    props.onAddApiKey(provider, key.trim(), baseUrl.trim().length > 0 ? baseUrl.trim() : undefined);
    setKey("");
  };

  const saveCustom = (): void => {
    const models = newModels
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (newId.trim().length === 0 || newBaseUrl.trim().length === 0 || models.length === 0) return;
    props.onAddCustom({
      id: newId.trim(),
      api: newApi,
      baseUrl: newBaseUrl.trim(),
      key: newKey.trim(),
      models,
    });
    setNewKey("");
  };

  return (
    <div className="dialog-mask" onClick={props.onClose}>
      <div className="sheet providers-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-head">
          <Icon name="key" size={15} />
          <h2>Providers &amp; models</h2>
          <button type="button" className="icon-btn" title="Close" onClick={props.onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>

        {status !== null && (
          <div className={`provider-status ${status.ok ? "ok" : "bad"} ${busy ? "busy" : ""}`}>
            {busy && <Icon name="spinner" size={13} />}
            <span>{status.message}</span>
          </div>
        )}

        {props.oauthAvailable && (
          <section className="sheet-section">
            <div className="sheet-section-title">Subscription sign-in</div>
            <div className="oauth-grid">
              {OAUTH_PROVIDERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="btn ghost small"
                  disabled={busy}
                  onClick={() => props.onOAuthLogin(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            {busy && (
              <button type="button" className="link-btn" onClick={props.onOAuthCancel}>
                Cancel sign-in
              </button>
            )}
            {props.oauthMessage !== null && <div className="oauth-message">{props.oauthMessage}</div>}
          </section>
        )}

        <section className="sheet-section">
          <div className="sheet-section-title">
            Detected models
            {discovered !== null && (
              <button
                type="button"
                className="link-btn"
                disabled={busy}
                onClick={() => props.onDetect(discovered.provider)}
              >
                Re-detect
              </button>
            )}
          </div>
          {discovered === null && (
            <div className="popover-empty">
              Save an API key and every model the credential can use is detected automatically.
            </div>
          )}
          {discovered !== null && discovered.models.length === 0 && (
            <div className="popover-empty">
              {discovered.source === "none"
                ? `No models detected for ${discovered.provider}.`
                : `${discovered.provider}: no models.`}
            </div>
          )}
          {discovered !== null && discovered.models.length > 0 && (
            <div className="detected-list">
              <div className="detected-summary">
                <code>{discovered.provider}</code>
                <span className="provider-source">{discovered.source}</span>
                <span className="provider-source">
                  {discovered.models.length} model{discovered.models.length === 1 ? "" : "s"}
                  {reasoningCount > 0 ? ` · ${reasoningCount} reasoning` : ""}
                </span>
              </div>
              {discovered.models.map((model) => {
                const key = `${discovered.provider}/${model.id}`;
                const reasoning = reasoningDraft[key] ?? model.reasoning;
                const level = levelDraft[key] ?? model.thinkingLevel;
                return (
                  <div key={key} className="detected-row">
                    <div className="detected-head">
                      <span className="detected-id" title={model.id}>
                        {model.name ?? model.id}
                      </span>
                      <label className="detected-toggle" title="Reasoning model">
                        <input
                          type="checkbox"
                          checked={reasoning}
                          onChange={(event) => {
                            const next = event.target.checked;
                            setReasoningDraft((current) => ({ ...current, [key]: next }));
                            props.onSetReasoning(discovered.provider, model.id, next);
                          }}
                        />
                        reasoning
                      </label>
                    </div>
                    {reasoning && (
                      <label className="detected-depth">
                        <span>depth</span>
                        <select
                          value={level}
                          onChange={(event) => {
                            const next = event.target.value;
                            setLevelDraft((current) => ({ ...current, [key]: next }));
                            props.onSetThinking(discovered.provider, model.id, next);
                          }}
                        >
                          {THINKING_LEVELS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="sheet-section">
          <div className="sheet-section-title">Configured</div>
          {props.providers.length === 0 && <div className="popover-empty">No credentials yet.</div>}
          <div className="provider-list">
            {props.providers.map((entry) => (
              <div key={entry.id} className="provider-row">
                <div className="provider-row-head">
                  <code className="provider-id" title={entry.id}>
                    {entry.id}
                  </code>
                  <span className={`provider-badge ${entry.source}`}>{entry.type}</span>
                  <span className="provider-source">{entry.source}</span>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={`Remove ${entry.id}`}
                    disabled={busy}
                    onClick={() => props.onRemove(entry.id)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                <div className="provider-row-body">
                  <div className="provider-line">
                    <span className="provider-line-label">key</span>
                    <span className="provider-masked" title={entry.masked}>
                      {entry.masked}
                    </span>
                  </div>
                  {entry.baseUrl !== undefined && entry.baseUrl.length > 0 && (
                    <div className="provider-line">
                      <span className="provider-line-label">url</span>
                      <span className="provider-base" title={entry.baseUrl}>
                        {entry.baseUrl}
                      </span>
                    </div>
                  )}
                  {entry.models.length > 0 && (
                    <div className="provider-line">
                      <span className="provider-line-label">models</span>
                      <span className="provider-models" title={entry.models.join(", ")}>
                        {summarizeModels(entry.models)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="sheet-section">
          <div className="sheet-tabs">
            <button type="button" className={tab === "key" ? "active" : ""} onClick={() => setTab("key")}>
              API key
            </button>
            <button type="button" className={tab === "custom" ? "active" : ""} onClick={() => setTab("custom")}>
              New model source
            </button>
          </div>

          {tab === "key" ? (
            <form
              className="provider-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveApiKey();
              }}
            >
              <label className="field">
                <span>Provider</span>
                <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                  {KNOWN_PROVIDERS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>API key</span>
                <input
                  type="password"
                  value={key}
                  placeholder="sk-…"
                  onChange={(event) => setKey(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Endpoint override (optional)</span>
                <input
                  value={baseUrl}
                  placeholder="https://gateway.example.com/v1"
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <div className="form-actions">
                <button
                  type="submit"
                  className="btn primary"
                  disabled={busy || key.trim().length === 0}
                >
                  Save &amp; verify
                </button>
              </div>
            </form>
          ) : (
            <form
              className="provider-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveCustom();
              }}
            >
              <label className="field">
                <span>Provider id</span>
                <input
                  value={newId}
                  placeholder="my-vllm"
                  onChange={(event) => setNewId(event.target.value)}
                />
              </label>
              <label className="field">
                <span>API</span>
                <select value={newApi} onChange={(event) => setNewApi(event.target.value as ApiFormat)}>
                  {API_FORMATS.map((format) => (
                    <option key={format.id} value={format.id}>
                      {format.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={newBaseUrl}
                  placeholder="http://localhost:8000/v1"
                  onChange={(event) => setNewBaseUrl(event.target.value)}
                />
              </label>
              <label className="field">
                <span>API key (optional for local servers)</span>
                <input
                  type="password"
                  value={newKey}
                  placeholder="ollama"
                  onChange={(event) => setNewKey(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Model ids (comma separated)</span>
                <input
                  value={newModels}
                  placeholder="qwen2.5-coder:7b, llama3.1:8b"
                  onChange={(event) => setNewModels(event.target.value)}
                />
              </label>
              <div className="form-actions">
                <button
                  type="submit"
                  className="btn primary"
                  disabled={busy || newId.trim().length === 0 || newBaseUrl.trim().length === 0}
                >
                  Save &amp; verify
                </button>
              </div>
            </form>
          )}
        </section>

        <p className="sheet-note">
          Credentials are written to <code>~/.pi/agent/auth.json</code>; endpoints and model lists to{" "}
          <code>~/.pi/agent/models.json</code>. Every save is verified with <code>pi auth check</code>, and the
          engine restarts so the model list refreshes.
        </p>
      </div>
    </div>
  );
}
