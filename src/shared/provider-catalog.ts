/**
 * Provider catalogs shared by the extension host and the webview. Keep this
 * file free of Node imports so the webview bundle can include it.
 */

export type ApiFormat =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export const API_FORMATS: readonly { id: ApiFormat; label: string }[] = [
  { id: "openai-completions", label: "OpenAI Chat Completions (most compatible)" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
];

/**
 * Common API-key providers offered in the "add credential" form. `api` and
 * `baseUrl` are the defaults used to probe `<baseUrl>/models` right after a key
 * is saved, so the extension can enumerate every model the account can use.
 * They are intentionally omitted where the endpoint is not stable; discovery
 * then falls back to pi's own catalog.
 */
export interface KnownProvider {
  readonly id: string;
  readonly label: string;
  readonly api?: ApiFormat;
  readonly baseUrl?: string;
}

export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
  { id: "anthropic", label: "Anthropic (Claude)", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  {
    id: "google",
    label: "Google Gemini",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  { id: "deepseek", label: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" },
  { id: "xai", label: "xAI (Grok)", api: "openai-completions", baseUrl: "https://api.x.ai/v1" },
  { id: "openrouter", label: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "groq", label: "Groq", api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", label: "Mistral", api: "openai-completions", baseUrl: "https://api.mistral.ai/v1" },
  { id: "cerebras", label: "Cerebras", api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
  {
    id: "fireworks",
    label: "Fireworks",
    api: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
  },
  { id: "together", label: "Together AI", api: "openai-completions", baseUrl: "https://api.together.xyz/v1" },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    api: "openai-completions",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  { id: "minimax", label: "MiniMax", api: "openai-completions", baseUrl: "https://api.minimax.io/v1" },
  { id: "zai", label: "ZAI Coding Plan" },
  { id: "kimi-coding", label: "Kimi For Coding" },
  { id: "huggingface", label: "Hugging Face", api: "openai-completions", baseUrl: "https://router.huggingface.co/v1" },
];

/** Reasoning depth levels pi understands, in escalating order. */
export const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Default reasoning depth applied to every reasoning model. */
export const DEFAULT_THINKING_LEVEL = "medium";

export function knownProvider(id: string): KnownProvider | undefined {
  return KNOWN_PROVIDERS.find((provider) => provider.id === id);
}

/** OAuth subscription providers, matching pi's bundled loaders. */
export const OAUTH_PROVIDERS: readonly { id: string; label: string }[] = [
  { id: "openai-codex", label: "ChatGPT Plus / Pro (Codex)" },
  { id: "anthropic", label: "Claude Pro / Max" },
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "xai", label: "xAI (Grok / X)" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "kimi-coding", label: "Kimi For Coding" },
  { id: "meta", label: "Meta (Muse)" },
  { id: "radius", label: "Radius (pi gateway)" },
];
