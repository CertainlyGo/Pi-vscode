import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OAuthEventView, OAuthPromptView } from "../shared/protocol";
import type { Credential } from "./auth-store";

/**
 * OAuth subscription login, reusing pi's own PKCE flows.
 *
 * The flows live in `@earendil-works/pi-ai/dist/auth/oauth/` but the public
 * export only exposes types, so we deep-import by absolute file path (the pi
 * version is pinned by the user's install). We only implement two thin shells:
 * bridge `prompt()` to a webview dialog and `notify()` to notifications plus
 * `vscode.env.openExternal`.
 */

export type OAuthProviderId =
  | "anthropic"
  | "openai-codex"
  | "github-copilot"
  | "openrouter"
  | "kimi-coding"
  | "xai"
  | "meta"
  | "radius";

const LOADER_NAMES: Record<OAuthProviderId, string> = {
  anthropic: "loadAnthropicOAuth",
  "openai-codex": "loadOpenAICodexOAuth",
  "github-copilot": "loadGitHubCopilotOAuth",
  openrouter: "loadOpenRouterOAuth",
  "kimi-coding": "loadKimiCodingOAuth",
  xai: "loadXaiOAuth",
  meta: "loadMetaOAuth",
  radius: "loadRadiusOAuth",
};

export interface OAuthHandlers {
  readonly prompt: (view: OAuthPromptView) => Promise<string>;
  readonly event: (view: OAuthEventView) => void;
}

/** Locate the pi-ai package that ships the OAuth flow modules. */
export function findPiAiRoot(packageDir: string | undefined): string | undefined {
  const candidates: string[] = [];
  if (packageDir !== undefined) {
    candidates.push(join(packageDir, "node_modules", "@earendil-works", "pi-ai"));
    candidates.push(join(dirname(packageDir), "pi-ai"));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "dist", "auth", "oauth", "load.js"))) return candidate;
  }
  return undefined;
}

/** Native dynamic import, hidden from the bundler so ESM stays ESM. */
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

export async function runOAuthLogin(options: {
  readonly piAiRoot: string;
  readonly provider: OAuthProviderId;
  readonly handlers: OAuthHandlers;
  readonly signal: AbortSignal;
}): Promise<Credential> {
  const loadUrl = pathToFileURL(join(options.piAiRoot, "dist", "auth", "oauth", "load.js")).href;
  const module = await nativeImport(loadUrl);
  const loaderName = LOADER_NAMES[options.provider];
  const loader = module[loaderName];
  if (typeof loader !== "function") {
    throw new Error(`OAuth loader not found: ${options.provider} (${loaderName})`);
  }

  const auth = (await (options.provider === "radius"
    ? (loader as (options: unknown) => Promise<unknown>)({
        name: "Radius",
        gateway: await loadRadiusGateway(options.piAiRoot),
      })
    : (loader as () => Promise<unknown>)())) as {
    login: (interaction: unknown) => Promise<Credential>;
  };

  const interaction = {
    signal: options.signal,
    prompt: async (prompt: unknown): Promise<string> => options.handlers.prompt(toPromptView(prompt)),
    notify: (event: unknown): void => options.handlers.event(toEventView(event)),
  };
  return auth.login(interaction);
}

async function loadRadiusGateway(piAiRoot: string): Promise<string> {
  const fallback = "https://radius.pi.dev";
  try {
    const url = pathToFileURL(join(piAiRoot, "dist", "providers", "radius-config.js")).href;
    const module = await nativeImport(url);
    const gateway = module["DEFAULT_RADIUS_GATEWAY"];
    return typeof gateway === "string" ? gateway : fallback;
  } catch {
    return fallback;
  }
}

function toPromptView(value: unknown): OAuthPromptView {
  const record = asRecord(value);
  const type = record["type"];
  const message = typeof record["message"] === "string" ? record["message"] : "Sign in";
  const placeholder = typeof record["placeholder"] === "string" ? record["placeholder"] : undefined;
  if (type === "select") {
    const options = Array.isArray(record["options"])
      ? (record["options"] as unknown[]).map((option) => {
          const entry = asRecord(option);
          return {
            id: String(entry["id"] ?? entry["label"] ?? ""),
            label: String(entry["label"] ?? entry["id"] ?? ""),
            ...(typeof entry["description"] === "string" ? { description: entry["description"] } : {}),
          };
        })
      : [];
    return { type: "select", message, options };
  }
  const resolvedType =
    type === "secret" ? "secret" : type === "manual_code" ? "manual_code" : "text";
  return {
    type: resolvedType,
    message,
    ...(placeholder !== undefined ? { placeholder } : {}),
  };
}

function toEventView(value: unknown): OAuthEventView {
  const record = asRecord(value);
  switch (record["type"]) {
    case "auth_url":
      return {
        kind: "auth_url",
        url: String(record["url"] ?? ""),
        ...(typeof record["instructions"] === "string" ? { instructions: record["instructions"] } : {}),
      };
    case "device_code":
      return {
        kind: "device_code",
        userCode: String(record["userCode"] ?? ""),
        verificationUri: String(record["verificationUri"] ?? ""),
        ...(typeof record["expiresInSeconds"] === "number"
          ? { expiresInSeconds: record["expiresInSeconds"] }
          : {}),
      };
    case "progress":
      return { kind: "progress", message: String(record["message"] ?? "") };
    default: {
      return {
        kind: "info",
        message: String(record["message"] ?? ""),
      };
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
