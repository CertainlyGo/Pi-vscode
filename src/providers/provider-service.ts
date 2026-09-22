import type { PiLaunch } from "../engine/locate-pi";
import type { ProviderInfo } from "../shared/protocol";
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
  listModelProviders,
  removeProvider,
  setCustomProvider,
  setProviderBaseUrl,
} from "./models-config";
import type { ApiFormat } from "./models-config";
import { findPiAiRoot, runOAuthLogin } from "./oauth";
import type { OAuthHandlers, OAuthProviderId } from "./oauth";

export interface ProviderResult {
  readonly ok: boolean;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
