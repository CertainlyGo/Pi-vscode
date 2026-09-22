import type { JSX } from "react";
import { useState } from "react";
import type { ProviderInfo } from "../../../src/shared/protocol";
import { API_FORMATS, KNOWN_PROVIDERS, OAUTH_PROVIDERS } from "../../../src/shared/provider-catalog";
import type { ApiFormat } from "../../../src/shared/provider-catalog";
import type { ProviderStatus } from "../store";
import { Icon } from "./Icons";

export interface ProvidersSheetProps {
  readonly providers: readonly ProviderInfo[];
  readonly oauthAvailable: boolean;
  readonly status: ProviderStatus | null;
  readonly oauthMessage: string | null;
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
  readonly onOAuthLogin: (provider: string) => void;
  readonly onOAuthCancel: () => void;
}

type Tab = "key" | "custom";

export function ProvidersSheet(props: ProvidersSheetProps): JSX.Element {
  const { status } = props;
  const busy = status?.busy === true;
  const [tab, setTab] = useState<Tab>("key");

  const [provider, setProvider] = useState(KNOWN_PROVIDERS[0]?.id ?? "openai");
  const [customProvider, setCustomProvider] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const [newId, setNewId] = useState("");
  const [newApi, setNewApi] = useState<ApiFormat>("openai-completions");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newModels, setNewModels] = useState("");

  const isCustomTarget = provider === "__custom__";
  const targetId = isCustomTarget ? customProvider.trim() : provider;

  const saveApiKey = (): void => {
    if (targetId.length === 0 || key.trim().length === 0) return;
    props.onAddApiKey(targetId, key.trim(), baseUrl.trim().length > 0 ? baseUrl.trim() : undefined);
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
          <div className="sheet-section-title">Configured</div>
          {props.providers.length === 0 && <div className="popover-empty">No credentials yet.</div>}
          <div className="provider-list">
            {props.providers.map((entry) => (
              <div key={entry.id} className="provider-row">
                <div className="provider-row-main">
                  <code className="provider-id">{entry.id}</code>
                  <span className={`provider-badge ${entry.source}`}>{entry.type}</span>
                  <span className="provider-masked" title={entry.masked}>
                    {entry.masked}
                  </span>
                </div>
                <div className="provider-row-meta">
                  {entry.baseUrl !== undefined && (
                    <span className="provider-base" title={entry.baseUrl}>
                      {entry.baseUrl}
                    </span>
                  )}
                  {entry.models.length > 0 && (
                    <span className="provider-models">{entry.models.length} models</span>
                  )}
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
                  <option value="__custom__">Custom provider id…</option>
                </select>
              </label>
              {isCustomTarget && (
                <label className="field">
                  <span>Provider id</span>
                  <input
                    value={customProvider}
                    placeholder="my-gateway"
                    onChange={(event) => setCustomProvider(event.target.value)}
                  />
                </label>
              )}
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
                  disabled={busy || targetId.length === 0 || key.trim().length === 0}
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
