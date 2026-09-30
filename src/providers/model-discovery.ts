import type { ApiFormat } from "../shared/provider-catalog";

/**
 * Enumerate the models a provider endpoint exposes for a given API key.
 *
 * This is the "detect everything the credential can use" half of the provider
 * flow: after an API key is stored we probe the provider's model-list endpoint,
 * translate the (three) response shapes into a flat list, and guess which of
 * them are reasoning models. The probe runs for built-in and custom providers
 * alike; the caller merges the result with pi's catalog so built-in metadata is
 * never lost.
 */

export interface EndpointModel {
  readonly id: string;
  readonly name?: string;
  /** True when the endpoint or an id heuristic marks the model as reasoning. */
  readonly reasoning: boolean;
}

export interface FetchModelsOptions {
  readonly api: ApiFormat;
  readonly baseUrl: string;
  readonly key: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly maxModels?: number;
}

export type FetchModelsResult =
  | { readonly ok: true; readonly models: readonly EndpointModel[] }
  | { readonly ok: false; readonly message: string };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MODELS = 2_000;

/**
 * Reasoning families we can recognise from the id alone. Only used when the
 * endpoint gives no explicit signal, and the user can always flip the flag in
 * the UI, so the patterns stay deliberately conservative.
 */
const REASONING_PATTERNS: readonly RegExp[] = [
  /(^|[\W_])o[1-9]([\W_]|$)/i, // o1, o3, o4-mini
  /gpt-[5-9]/i, // gpt-5.x and newer
  /(^|[\W_])(thinking|reasoning|think)([\W_]|$)/i,
  /deepseek-r\d/i,
  /(^|[\W_])r1([\W_]|$)/i,
  /qwq|qvq/i,
  /qwen3/i,
  /magistral/i,
  /claude-(3[.-]7|(?:opus|sonnet|haiku)-[4-9])/i,
  /gemini-(2\.5|3)/i,
  /grok-[3-9]/i,
  /kimi-k2/i,
  /glm-4\.[5-9]/i,
  /minimax-m[12]/i,
];

/** Best-effort reasoning detection from a model id. */
export function inferReasoning(modelId: string): boolean {
  return REASONING_PATTERNS.some((pattern) => pattern.test(modelId));
}

/** Resolve the model-list URL for a provider endpoint (idempotent). */
export function modelsEndpoint(api: ApiFormat, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.length === 0) return "";
  const lower = base.toLowerCase();
  if (lower.endsWith("/models")) return base;
  switch (api) {
    case "anthropic-messages":
      // Anthropic's public API is versioned (`/v1/models`); gateways that
      // already carry a version segment are left untouched.
      return /\/(v1|v1beta)(\/|$)/i.test(base) ? `${base}/models` : `${base}/v1/models`;
    case "google-generative-ai":
      return `${base}/models`;
    default:
      return `${base}/models`;
  }
}

function authHeaders(api: ApiFormat, key: string): Record<string, string> {
  switch (api) {
    case "anthropic-messages":
      return { "x-api-key": key, "anthropic-version": "2023-06-01" };
    case "google-generative-ai":
      return { "x-goog-api-key": key };
    default:
      return { Authorization: `Bearer ${key}` };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** True when a model payload advertises reasoning/thinking support. */
function payloadReasoning(item: Record<string, unknown>): boolean {
  if (item["reasoning"] === true) return true;
  if (asRecord(item["capabilities"])["reasoning"] === true) return true;
  const parameters = item["supported_parameters"];
  if (Array.isArray(parameters)) {
    if (parameters.some((entry) => typeof entry === "string" && /reason/i.test(entry))) return true;
  }
  const tags = item["tags"];
  if (Array.isArray(tags) && tags.some((entry) => typeof entry === "string" && /reason/i.test(entry))) {
    return true;
  }
  const name = str(item["name"]) ?? str(item["display_name"]) ?? str(item["displayName"]);
  return name !== undefined && /reason|thinking/i.test(name);
}

/**
 * Normalize one provider response into model ids.
 *
 * Supported shapes:
 *  - OpenAI-compatible (OpenAI, DeepSeek, Groq, OpenRouter, Ollama, vLLM, …)
 *    `{ data: [{ id, name? }] }` or `{ models: [{ id }] }`
 *  - Anthropic `{ data: [{ id, display_name }] }`
 *  - Google `{ models: [{ name: "models/gemini-…", displayName }] }`
 */
export function parseModelsResponse(
  _api: ApiFormat,
  payload: unknown,
  limit = DEFAULT_MAX_MODELS,
): EndpointModel[] {
  const root = asRecord(payload);
  const list = Array.isArray(root["data"])
    ? (root["data"] as unknown[])
    : Array.isArray(root["models"])
      ? (root["models"] as unknown[])
      : Array.isArray(payload)
        ? (payload as unknown[])
        : [];

  const models: EndpointModel[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw === "string") {
      const id = raw.trim();
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, reasoning: inferReasoning(id) });
      if (models.length >= limit) break;
      continue;
    }
    const item = asRecord(raw);
    const id = str(item["id"]) ?? str(item["model"]) ?? str(item["name"])?.replace(/^models\//, "");
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const name = str(item["display_name"]) ?? str(item["displayName"]) ?? str(item["name"]);
    const explicit = payloadReasoning(item);
    models.push({
      id,
      ...(name !== undefined && name !== id ? { name } : {}),
      reasoning: explicit || inferReasoning(id),
    });
    if (models.length >= limit) break;
  }
  // Google returns fully qualified ids (`models/gemini-…`), normalized above.
  return models;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Probe a provider endpoint for the models this credential can use. */
export async function fetchEndpointModels(options: FetchModelsOptions): Promise<FetchModelsResult> {
  const url = modelsEndpoint(options.api, options.baseUrl);
  if (url.length === 0) return { ok: false, message: "No base URL configured for this provider." };
  if (options.key.trim().length === 0) return { ok: false, message: "No API key available to query the endpoint." };

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders(options.api, options.key.trim()) },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await safeText(response);
      return {
        ok: false,
        message: `GET ${url} failed: ${response.status}${response.statusText.length > 0 ? ` ${response.statusText}` : ""}${detail.length > 0 ? ` — ${detail}` : ""}`,
      };
    }
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (error) {
      return { ok: false, message: `GET ${url} returned invalid JSON: ${describeError(error)}` };
    }
    const models = parseModelsResponse(options.api, payload, options.maxModels ?? DEFAULT_MAX_MODELS);
    if (models.length === 0) return { ok: false, message: `GET ${url} returned no models.` };
    return { ok: true, models };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, message: `GET ${url} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.` };
    }
    return { ok: false, message: `GET ${url} failed: ${describeError(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}
