import type { PiLaunch } from "../engine/locate-pi";
import type { DiscoveredModel, DiscoverySource, ProviderInfo } from "../shared/protocol";
import { DEFAULT_THINKING_LEVEL, knownProvider } from "../shared/provider-catalog";
import {
  ENV_PROVIDERS,
  checkProviderAuth,
  getAuthPath,
  loadAuthFile,
  maskKey,
  removeCredential,
  saveCredential,
} from "./auth-store";
import type { Credential } from "./auth-store";
import {
  getModelsPath,
  listModelEntries,
  listModelProviders,
  removeProvider,
  setCustomProvider,
  setDiscoveredModels,
  setModelOverrideReasoning,
  setModelReasoning,
  setProviderBaseUrl,
} from "./models-config";
import type { ApiFormat } from "./models-config";
import { fetchEndpointModels } from "./model-discovery";
import { findPiAiRoot, runOAuthLogin } from "./oauth";
import type { OAuthHandlers, OAuthProviderId } from "./oauth";
import { getModelThinkingLevels, getSettingsPath, setModelThinkingLevel, setModelThinkingLevels } from "./settings-config";

export interface ProviderResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Result of enumerating the models a provider credential can use. */
export interface DiscoveryOutcome {
  readonly models: readonly DiscoveredModel[];
  readonly source: DiscoverySource;
  readonly message: string;
}

export interface ProviderServiceOptions {
  readonly getAgentDir: () => string;
  readonly getLaunch: () => PiLaunch | undefined;
  readonly openExternal: (url: string) => void;
  readonly log: (message: string) => void;
}

/**
 * Credential and model-source management. This is the extension's management
 * plane: it writes pi's own `auth.json` / `models.json` and verifies every
 * change with `pi auth check`.
 */
export class ProviderService {
  readonly #options: ProviderServiceOptions;

  constructor(options: ProviderServiceOptions) {
    this.#options = options;
  }

  get oauthAvailable(): boolean {
    return findPiAiRoot(this.#options.getLaunch()?.packageDir) !== undefined;
  }

  async list(): Promise<ProviderInfo[]> {
    const agentDir = this.#options.getAgentDir();
    let auth: Record<string, Credential>;
    try {
      auth = await loadAuthFile(getAuthPath(agentDir));
    } catch (error) {
      this.#options.log(`could not read auth.json: ${describe(error)}`);
      auth = {};
    }
    const modelProviders = await listModelProviders(getModelsPath(agentDir));
    const byId = new Map(modelProviders.map((provider) => [provider.id, provider]));

    const infos: ProviderInfo[] = [];
    for (const [id, credential] of Object.entries(auth)) {
      const model = byId.get(id);
      infos.push({
        id,
        type: credential.type,
        masked: credential.type === "oauth" ? "subscription" : maskKey(credential.key),
        source: "auth",
        ...(model?.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
        ...(model?.api !== undefined ? { api: model.api } : {}),
        models: model?.models ?? [],
      });
      byId.delete(id);
    }

    for (const provider of byId.values()) {
      infos.push({
        id: provider.id,
        type: "endpoint",
        masked: "no credential",
        source: "endpoint",
        ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
        ...(provider.api !== undefined ? { api: provider.api } : {}),
        models: provider.models,
      });
    }

    for (const env of ENV_PROVIDERS) {
      if (process.env[env.variable] === undefined || process.env[env.variable]?.length === 0) continue;
      if (auth[env.id] !== undefined) continue;
      infos.push({
        id: env.id,
        type: "env",
        masked: `$${env.variable}`,
        source: "env",
        models: [],
      });
    }

    infos.sort((a, b) => a.id.localeCompare(b.id));
    return infos;
  }

  /** Store an API key, optionally overriding the provider's base URL. */
  async addApiKey(provider: string, key: string, baseUrl?: string): Promise<ProviderResult> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
      return { ok: false, message: `Invalid provider id "${provider}".` };
    }
    if (key.trim().length === 0) return { ok: false, message: "API key is empty." };
    const agentDir = this.#options.getAgentDir();
    await saveCredential(getAuthPath(agentDir), provider, { type: "api_key", key: key.trim() });
    if (baseUrl !== undefined && baseUrl.trim().length > 0) {
      await setProviderBaseUrl(getModelsPath(agentDir), provider, baseUrl.trim());
    }
    return this.validate(provider, `Saved ${provider}.`);
  }

  /** Create or update a custom provider with an explicit API type and models. */
  async addCustomProvider(input: {
    readonly id: string;
    readonly api: ApiFormat;
    readonly baseUrl: string;
    readonly key: string;
    readonly models: readonly string[];
  }): Promise<ProviderResult> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.id)) {
      return { ok: false, message: `Invalid provider id "${input.id}". Use lowercase letters, digits and dashes.` };
    }
    if (input.baseUrl.trim().length === 0) return { ok: false, message: "Base URL is required." };
    if (input.models.length === 0) return { ok: false, message: "Add at least one model id." };
    const agentDir = this.#options.getAgentDir();
    if (input.key.trim().length > 0) {
      await saveCredential(getAuthPath(agentDir), input.id, { type: "api_key", key: input.key.trim() });
    }
    await setCustomProvider(getModelsPath(agentDir), input.id, {
      baseUrl: input.baseUrl.trim(),
      api: input.api,
      models: input.models,
    });
    return this.validate(input.id, `Saved model source ${input.id}.`);
  }

  async remove(provider: string): Promise<ProviderResult> {
    const agentDir = this.#options.getAgentDir();
    const removedCredential = await removeCredential(getAuthPath(agentDir), provider);
    await removeProvider(getModelsPath(agentDir), provider);
    if (!removedCredential) {
      return { ok: true, message: `Removed model source ${provider}.` };
    }
    return { ok: true, message: `Removed credentials for ${provider}.` };
  }

  /**
   * Enumerate every model a provider credential can use and remember them.
   *
   * Whenever a stored key plus a base URL exist we ask the endpoint itself —
   * `<baseUrl>/models` — because only the vendor knows its full catalogue
   * (aggregators like OpenRouter, Together or Fireworks expose far more than pi
   * ships). Endpoint models pi already knows are kept from `catalogModels` so
   * their context window, pricing and capabilities survive; only genuinely new
   * ids are written to `models.json`, which is what makes them selectable after
   * the next engine start. Reasoning models get a default `medium` depth. When
   * there is no key/endpoint to probe, pi's catalog is used as-is.
   */
  async discoverModels(
    provider: string,
    options: { readonly catalogModels?: readonly DiscoveredModel[] } = {},
  ): Promise<DiscoveryOutcome> {
    const catalog = options.catalogModels ?? [];
    const agentDir = this.#options.getAgentDir();
    const modelsPath = getModelsPath(agentDir);
    const declared = (await listModelProviders(modelsPath)).find((entry) => entry.id === provider);

    const fromCatalog = async (message: string): Promise<DiscoveryOutcome> => {
      const models = await this.#annotate(provider, catalog);
      return { models, source: "catalog", message };
    };
    const catalogMessage =
      `${provider}: ${catalog.length} model${catalog.length === 1 ? "" : "s"} available from pi's catalog.`;

    const defaults = knownProvider(provider);
    const baseUrl = declared?.baseUrl ?? defaults?.baseUrl;
    const api = (declared?.api ?? defaults?.api) as ApiFormat | undefined;
    if (baseUrl === undefined || api === undefined) {
      if (catalog.length > 0) return fromCatalog(catalogMessage);
      return {
        models: [],
        source: "none",
        message: `No endpoint known for ${provider}; add a base URL to detect its models.`,
      };
    }

    const key = await this.#credentialKey(provider);
    if (key === undefined) {
      if (catalog.length > 0) return fromCatalog(catalogMessage);
      return { models: [], source: "none", message: `No API key stored for ${provider}.` };
    }

    const probed = await fetchEndpointModels({ api, baseUrl, key });
    if (!probed.ok) {
      if (catalog.length > 0) {
        return fromCatalog(`${catalogMessage} Endpoint probe failed: ${probed.message}`);
      }
      return { models: [], source: "none", message: `Could not list ${provider} models: ${probed.message}` };
    }

    // Only write ids pi does not already know. A `models.json` entry with the
    // same id as a catalog model would shadow its metadata, and a built-in
    // provider's base URL (from the catalog) may differ from the probe URL.
    const known = new Set(catalog.map((model) => model.id));
    const toWrite = probed.models.filter((model) => !known.has(model.id));
    const added = await setDiscoveredModels(
      modelsPath,
      provider,
      toWrite,
      catalog.length === 0 ? { baseUrl, api } : {},
    );

    const models = await this.#annotate(provider, mergeWithCatalog(catalog, probed.models));
    const reasoning = models.filter((model) => model.reasoning).length;
    const source: DiscoverySource = catalog.length === 0 || added > 0 ? "endpoint" : "catalog";
    const message =
      added > 0
        ? `Added ${added} new model${added === 1 ? "" : "s"} from ${provider}` +
          ` (${models.length} available${reasoning > 0 ? `, ${reasoning} reasoning` : ""}).`
        : `${provider}: ${models.length} model${models.length === 1 ? "" : "s"} available — ` +
          "every model the endpoint offers is already known to pi.";
    return { models, source, message };
  }

  /** Turn a model's reasoning flag on or off. */
  async setModelReasoning(provider: string, modelId: string, reasoning: boolean): Promise<ProviderResult> {
    const agentDir = this.#options.getAgentDir();
    const modelsPath = getModelsPath(agentDir);
    // Built-in catalog models keep their catalog entry and only take a
    // non-destructive `modelOverrides` entry. A model that discovery added to
    // `models.json` has to be edited in place, otherwise the override is
    // ignored for an id pi does not know yet.
    const discovered = (await listModelEntries(modelsPath, provider)).some((entry) => entry.id === modelId);
    if (knownProvider(provider) !== undefined && !discovered) {
      await setModelOverrideReasoning(modelsPath, provider, modelId, reasoning);
    } else {
      await setModelReasoning(modelsPath, provider, modelId, reasoning);
    }
    if (reasoning) await this.#ensureThinkingDefault(provider, modelId);
    return {
      ok: true,
      message: `${provider}/${modelId} marked ${reasoning ? "as" : "as not"} a reasoning model.`,
    };
  }

  /** Persist the per-model reasoning depth written to settings.json. */
  async setThinkingLevel(provider: string, modelId: string, level: string): Promise<ProviderResult> {
    const agentDir = this.#options.getAgentDir();
    await setModelThinkingLevel(getSettingsPath(agentDir), provider, modelId, level);
    return { ok: true, message: `${provider}/${modelId} reasoning depth: ${level}.` };
  }

  /** Attach the effective reasoning depth and persist defaults for new models. */
  async #annotate(provider: string, models: readonly DiscoveredModel[]): Promise<DiscoveredModel[]> {
    const path = getSettingsPath(this.#options.getAgentDir());
    const levels = await getModelThinkingLevels(path);
    const defaults: Record<string, string> = {};
    const result: DiscoveredModel[] = [];
    for (const model of models) {
      const key = `${provider}/${model.id}`;
      if (model.reasoning && levels[key] === undefined) {
        defaults[key] = DEFAULT_THINKING_LEVEL;
        levels[key] = DEFAULT_THINKING_LEVEL;
      }
      result.push({ ...model, thinkingLevel: levels[key] ?? DEFAULT_THINKING_LEVEL });
    }
    await setModelThinkingLevels(path, defaults);
    return result;
  }

  async #ensureThinkingDefault(provider: string, modelId: string): Promise<void> {
    const path = getSettingsPath(this.#options.getAgentDir());
    const levels = await getModelThinkingLevels(path);
    if (levels[`${provider}/${modelId}`] !== undefined) return;
    await setModelThinkingLevel(path, provider, modelId, DEFAULT_THINKING_LEVEL);
  }

  /** Read the stored API key (or bearer token) for a provider, if any. */
  async #credentialKey(provider: string): Promise<string | undefined> {
    try {
      const auth = await loadAuthFile(getAuthPath(this.#options.getAgentDir()));
      const credential = auth[provider] as Credential | undefined;
      if (credential === undefined) return undefined;
      if (credential.type === "api_key" || credential.type === "bearer_token") {
        const key = credential.key;
        return typeof key === "string" && key.length > 0 ? key : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Run an OAuth subscription login and store the resulting credential. */
  async login(
    provider: OAuthProviderId,
    handlers: OAuthHandlers,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    const launch = this.#options.getLaunch();
    const piAiRoot = findPiAiRoot(launch?.packageDir);
    if (piAiRoot === undefined) {
      return {
        ok: false,
        message: "Could not locate pi's OAuth flows. Set `pi.executablePath` to a full pi install.",
      };
    }
    const credential = await runOAuthLogin({ piAiRoot, provider, handlers, signal });
    await saveCredential(getAuthPath(this.#options.getAgentDir()), provider, credential);
    return this.validate(provider, `Signed in to ${provider}.`);
  }

  /** Ask pi whether the provider is usable right now. */
  async validate(provider: string, prefix?: string): Promise<ProviderResult> {
    const launch = this.#options.getLaunch();
    if (launch === undefined) {
      return {
        ok: true,
        message: `${prefix ?? "Saved."} Start the engine to verify.`,
      };
    }
    const outcome = await checkProviderAuth({ launch, provider });
    const detail = outcome.message ?? outcome.reason ?? outcome.status;
    if (outcome.ok) return { ok: true, message: `${prefix ?? "Saved."} Verified: ready.` };
    return {
      ok: false,
      message: `${prefix ?? "Saved."} pi reports: ${detail}`,
    };
  }

  openExternal(url: string): void {
    this.#options.openExternal(url);
  }
}

/**
 * Union of pi's catalog and the endpoint's models. Catalog entries win on id
 * collisions so their richer metadata (reasoning, context, pricing) is shown;
 * endpoint-only ids are appended in the order the vendor returned them.
 */
function mergeWithCatalog(
  catalog: readonly DiscoveredModel[],
  endpoint: readonly { readonly id: string; readonly name?: string; readonly reasoning: boolean }[],
): DiscoveredModel[] {
  const merged: DiscoveredModel[] = [...catalog];
  const seen = new Set(catalog.map((model) => model.id));
  for (const model of endpoint) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push({
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      reasoning: model.reasoning,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
    });
  }
  return merged;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
