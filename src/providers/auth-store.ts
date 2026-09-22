import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PiLaunch } from "../engine/locate-pi";

/**
 * Read/write `~/.pi/agent/auth.json`.
 *
 * pi's SDK does not export a credential writer and the CLI has no write command
 * (the TUI `/login` is the only official path), so this is a deliberate narrow
 * exception: we touch this one file, follow the schema documented in
 * `docs/providers.md`, and always verify with `pi auth check` after writing.
 */

export const AUTH_FILE_MODE = 0o600;

export type Credential =
  | { type: "api_key" | "bearer_token"; key: string; [extra: string]: unknown }
  | { type: "oauth"; access: string; refresh: string; expires: number; [extra: string]: unknown };

export type AuthFile = Record<string, Credential>;

export class AuthFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthFileError";
  }
}

export function getAuthPath(agentDir: string): string {
  return join(agentDir, "auth.json");
}

/** Read auth.json. Missing file -> {}; corrupt JSON -> throw (never overwrite silently). */
export async function loadAuthFile(path: string): Promise<AuthFile> {
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
    throw new AuthFileError(
      `auth.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthFileError("auth.json must be an object");
  }
  const result: AuthFile = {};
  for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AuthFileError(`credential for ${provider} is not an object`);
    }
    const entry = value as Record<string, unknown>;
    const type = entry["type"];
    if (type === "oauth") {
      if (
        typeof entry["access"] !== "string" ||
        typeof entry["refresh"] !== "string" ||
        typeof entry["expires"] !== "number"
      ) {
        throw new AuthFileError(`oauth credential for ${provider} is missing access/refresh/expires`);
      }
      result[provider] = value as Credential;
      continue;
    }
    if (type !== "api_key" && type !== "bearer_token") {
      throw new AuthFileError(`credential for ${provider} has an invalid type`);
    }
    if (typeof entry["key"] !== "string") {
      throw new AuthFileError(`credential for ${provider} is missing key`);
    }
    result[provider] = value as Credential;
  }
  return result;
}

/** Merge one provider credential into auth.json, leaving other providers untouched. */
export async function saveCredential(
  path: string,
  provider: string,
  credential: Credential,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
    throw new AuthFileError(`invalid provider id: ${provider}`);
  }
  const current = await loadAuthFile(path);
  const next: AuthFile = { ...current, [provider]: credential };
  await writeAuthFile(path, next);
}

export async function removeCredential(path: string, provider: string): Promise<boolean> {
  const current = await loadAuthFile(path);
  if (!(provider in current)) return false;
  const rest: AuthFile = {};
  for (const [name, credential] of Object.entries(current)) {
    if (name !== provider) rest[name] = credential;
  }
  await writeAuthFile(path, rest);
  return true;
}

async function writeAuthFile(path: string, data: AuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: AUTH_FILE_MODE });
  // chmod is a no-op on Windows (ACLs); ignore failures.
  await chmod(path, AUTH_FILE_MODE).catch(() => undefined);
}

export interface AuthCheckOutcome {
  readonly ok: boolean;
  readonly status: "ready" | "not_ready" | "error";
  readonly reason?: string;
  readonly message?: string;
}

/**
 * Verify a provider with pi's own `auth check --json`. `--no-refresh` keeps it
 * local (no OAuth refresh round-trip).
 */
export function checkProviderAuth(options: {
  readonly launch: PiLaunch;
  readonly provider: string;
  readonly timeoutMs?: number;
}): Promise<AuthCheckOutcome> {
  return new Promise<AuthCheckOutcome>((resolve) => {
    const child = spawn(
      options.launch.command,
      [
        ...options.launch.args,
        "auth",
        "check",
        "--provider",
        options.provider,
        "--json",
        "--no-refresh",
      ],
      {
        env: { ...process.env, ...options.launch.env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 25_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: "error", message: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as {
          status?: string;
          reason?: string;
          message?: string;
        };
        const ready = parsed.status === "ready";
        resolve({
          ok: ready,
          status: ready ? "ready" : "not_ready",
          ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
          ...(parsed.message !== undefined ? { message: parsed.message } : {}),
        });
      } catch {
        resolve({
          ok: false,
          status: "error",
          ...(code !== 0 ? { reason: `exit code ${code ?? "?"}` } : {}),
          message: stderr.slice(0, 500) || "could not parse auth check output",
        });
      }
    });
  });
}

/** Providers pi can authenticate from an environment variable alone. */
export const ENV_PROVIDERS: readonly { id: string; variable: string; label: string }[] = [
  { id: "anthropic", variable: "ANTHROPIC_API_KEY", label: "Anthropic" },
  { id: "openai", variable: "OPENAI_API_KEY", label: "OpenAI" },
  { id: "google", variable: "GEMINI_API_KEY", label: "Google Gemini" },
  { id: "deepseek", variable: "DEEPSEEK_API_KEY", label: "DeepSeek" },
  { id: "xai", variable: "XAI_API_KEY", label: "xAI" },
  { id: "openrouter", variable: "OPENROUTER_API_KEY", label: "OpenRouter" },
  { id: "groq", variable: "GROQ_API_KEY", label: "Groq" },
  { id: "mistral", variable: "MISTRAL_API_KEY", label: "Mistral" },
  { id: "cerebras", variable: "CEREBRAS_API_KEY", label: "Cerebras" },
  { id: "fireworks", variable: "FIREWORKS_API_KEY", label: "Fireworks" },
  { id: "together", variable: "TOGETHER_API_KEY", label: "Together AI" },
  { id: "nvidia", variable: "NVIDIA_API_KEY", label: "NVIDIA NIM" },
  { id: "minimax", variable: "MINIMAX_API_KEY", label: "MiniMax" },
  { id: "kimi-coding", variable: "KIMI_API_KEY", label: "Kimi For Coding" },
  { id: "huggingface", variable: "HF_TOKEN", label: "Hugging Face" },
  { id: "amazon-bedrock", variable: "AWS_BEARER_TOKEN_BEDROCK", label: "Amazon Bedrock" },
];

export function maskKey(key: string): string {
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
