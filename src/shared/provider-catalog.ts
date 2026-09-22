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

/** Common API-key providers offered in the "add credential" form. */
export const KNOWN_PROVIDERS: readonly { id: string; label: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google Gemini" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "xai", label: "xAI (Grok)" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "groq", label: "Groq" },
  { id: "mistral", label: "Mistral" },
  { id: "cerebras", label: "Cerebras" },
  { id: "fireworks", label: "Fireworks" },
  { id: "together", label: "Together AI" },
  { id: "nvidia", label: "NVIDIA NIM" },
  { id: "minimax", label: "MiniMax" },
  { id: "zai", label: "ZAI Coding Plan" },
  { id: "kimi-coding", label: "Kimi For Coding" },
  { id: "huggingface", label: "Hugging Face" },
];

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
