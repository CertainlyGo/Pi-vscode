import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApiFormat } from "../shared/provider-catalog";

export type { ApiFormat };

/**
 * Read/merge `~/.pi/agent/models.json`.
 *
 * Custom endpoints and model sources use the documented schema from
 * `docs/models.md`: `{ "providers": { "<id>": { baseUrl, api, models: [...] } } }`.
 * Writes are merge-only — everything we do not touch is preserved verbatim.
 */

export class ModelsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsConfigError";
  }
}

export interface ModelProviderConfig {
  readonly id: string;
  readonly baseUrl?: string;
  readonly api?: string;
  readonly models: readonly string[];
}

/** One model entry as stored in `models.json`. */
export interface ModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
}

/** Input for auto-discovery: reasoning is only ever upgraded to `true`. */
export interface DiscoveredModelInput {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
}

export function getModelsPath(agentDir: string): string {
  return join(agentDir, "models.json");
}

/** Read models.json. Missing file -> {}; corrupt JSON -> throw. */
export async function readModelsConfig(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ModelsConfigError(
      `models.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelsConfigError("models.json must be an object");
  }
  return parsed as Record<string, unknown>;
}

async function writeModelsConfig(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function providersOf(config: Record<string, unknown>): Record<string, unknown> {
  const providers = config["providers"];
  return providers !== null && typeof providers === "object" && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)
    : {};
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Override only the base URL of an existing (usually built-in) provider. */
export async function setProviderBaseUrl(
  path: string,
  provider: string,
  baseUrl: string,
): Promise<void> {
  const config = await readModelsConfig(path);
  const providers = providersOf(config);
  const entry = objectOf(providers[provider]);
  await writeModelsConfig(path, {
    ...config,
    providers: { ...providers, [provider]: { ...entry, baseUrl } },
  });
}

/** Create or update a custom provider with an explicit API type and model list. */
export async function setCustomProvider(
  path: string,
  provider: string,
  options: {
    readonly baseUrl: string;
    readonly api: ApiFormat;
    readonly models: readonly string[];
  },
): Promise<void> {
  const config = await readModelsConfig(path);
  const providers = providersOf(config);
  const entry = objectOf(providers[provider]);
  const existingModels = Array.isArray(entry["models"]) ? (entry["models"] as unknown[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const model of existingModels) {
    const record = objectOf(model);
    const id = typeof record["id"] === "string" ? record["id"] : undefined;
    if (id !== undefined) byId.set(id, record);
  }
  for (const id of options.models) {
    if (!byId.has(id)) byId.set(id, { id });
  }
  const models = [...byId.values()];
  await writeModelsConfig(path, {
    ...config,
    providers: {
      ...providers,
      [provider]: {
        ...entry,
        baseUrl: options.baseUrl,
        api: options.api,
        models,
      },
    },
  });
}

/** Remove a provider entry from models.json. */
export async function removeProvider(path: string, provider: string): Promise<void> {
  const config = await readModelsConfig(path);
  const providers = providersOf(config);
  if (!(provider in providers)) return;
  const rest: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (id !== provider) rest[id] = entry;
  }
  await writeModelsConfig(path, { ...config, providers: rest });
}

/**
 * Merge auto-discovered models into a provider entry.
 *
 * Existing entries are preserved field-by-field — pi may already know a model's
 * context window, cost or thinking map — and `reasoning` is only ever upgraded
 * to `true`, never downgraded, so a heuristic miss cannot disable thinking for
 * a model pi's catalog considers a reasoning model.
 */
export async function setDiscoveredModels(
  path: string,
  provider: string,
  models: readonly DiscoveredModelInput[],
  options: { readonly baseUrl?: string; readonly api?: ApiFormat } = {},
): Promise<number> {
  if (models.length === 0) return 0;
  const config = await readModelsConfig(path);
  const providers = providersOf(config);
  const entry = objectOf(providers[provider]);
  const existingModels = Array.isArray(entry["models"]) ? (entry["models"] as unknown[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const model of existingModels) {
    const record = objectOf(model);
    const id = typeof record["id"] === "string" ? record["id"] : undefined;
    if (id !== undefined) byId.set(id, record);
  }

  let added = 0;
  for (const model of models) {
    const existing = byId.get(model.id);
    if (existing === undefined) {
      byId.set(model.id, {
        id: model.id,
        ...(model.name !== undefined && model.name !== model.id ? { name: model.name } : {}),
        ...(model.reasoning === true ? { reasoning: true } : {}),
      });
      added += 1;
      continue;
    }
    if (model.reasoning === true && existing["reasoning"] !== true) {
      byId.set(model.id, { ...existing, reasoning: true });
    }
  }

  await writeModelsConfig(path, {
    ...config,
    providers: {
      ...providers,
      [provider]: {
        ...entry,
        ...(options.baseUrl !== undefined && options.baseUrl.trim().length > 0
          ? { baseUrl: options.baseUrl.trim() }
          : {}),
        ...(options.api !== undefined ? { api: options.api } : {}),
        models: [...byId.values()],
      },
    },
  });
  return added;
}

/** Explicitly set a model's reasoning flag (user action, may set `false`). */
export async function setModelReasoning(
  path: string,
  provider: string,
  modelId: string,
  reasoning: boolean,
): Promise<void> {
  const config = await readModelsConfig(path);
  const providers = providersOf(config);
  const entry = objectOf(providers[provider]);
  const existingModels = Array.isArray(entry["models"]) ? (entry["models"] as unknown[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const model of existingModels) {
    const record = objectOf(model);
    const id = typeof record["id"] === "string" ? record["id"] : undefined;
    if (id !== undefined) byId.set(id, record);
  }
  const existing = byId.get(modelId) ?? { id: modelId };
  byId.set(modelId, { ...existing, reasoning });
  await writeModelsConfig(path, {
    ...config,
    providers: {
      ...providers,
      [provider]: { ...entry, models: [...byId.values()] },
    },
  });
}

/**
 * Override a built-in model's reasoning flag without touching the provider's
 * model list. pi applies `modelOverrides` on top of catalog/extension models,
 * so this cannot shadow the rest of the provider's catalog.
 */
export async function setModelOverrideReasoning(
  path: string,
  provider: string,
  modelId: string,
  reasoning: boolean,
): Promise<void> {
  const config = await readModelsConfig(path);
  const providers = providersOf(config);
  const entry = objectOf(providers[provider]);
  const rawOverrides = entry["modelOverrides"];
  const overrides =
    rawOverrides !== null && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)
      ? (rawOverrides as Record<string, unknown>)
      : {};
  const existing = objectOf(overrides[modelId]);
  await writeModelsConfig(path, {
    ...config,
    providers: {
      ...providers,
      [provider]: { ...entry, modelOverrides: { ...overrides, [modelId]: { ...existing, reasoning } } },
    },
  });
}

/** Read the model entries (id/name/reasoning) declared for a provider. */
export async function listModelEntries(path: string, provider: string): Promise<ModelEntry[]> {
  let config: Record<string, unknown>;
  try {
    config = await readModelsConfig(path);
  } catch {
    return [];
  }
  const entry = objectOf(providersOf(config)[provider]);
  if (!Array.isArray(entry["models"])) return [];
  const result: ModelEntry[] = [];
  for (const value of entry["models"] as unknown[]) {
    if (typeof value === "string") {
      result.push({ id: value });
      continue;
    }
    const record = objectOf(value);
    const id = typeof record["id"] === "string" ? record["id"] : undefined;
    if (id === undefined) continue;
    result.push({
      id,
      ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
      ...(typeof record["reasoning"] === "boolean" ? { reasoning: record["reasoning"] } : {}),
    });
  }
  return result;
}

/** Summarize providers declared in models.json for the UI. */
export async function listModelProviders(path: string): Promise<ModelProviderConfig[]> {
  let config: Record<string, unknown>;
  try {
    config = await readModelsConfig(path);
  } catch {
    return [];
  }
  const providers = providersOf(config);
  const result: ModelProviderConfig[] = [];
  for (const [id, value] of Object.entries(providers)) {
    const entry = objectOf(value);
    const models = Array.isArray(entry["models"])
      ? (entry["models"] as unknown[])
          .map((model) => objectOf(model)["id"])
          .filter((modelId): modelId is string => typeof modelId === "string")
      : [];
    result.push({
      id,
      ...(typeof entry["baseUrl"] === "string" ? { baseUrl: entry["baseUrl"] } : {}),
      ...(typeof entry["api"] === "string" ? { api: entry["api"] } : {}),
      models,
    });
  }
  return result;
}
