import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_THINKING_LEVEL } from "../shared/provider-catalog";

/**
 * Narrow read/write access to `~/.pi/agent/settings.json`.
 *
 * We only ever touch `modelThinkingLevels`, pi's documented map of per-model
 * startup reasoning depth keyed by `provider/modelId` (see `docs/settings.md`).
 * Writes are merge-only so hand-edited settings survive verbatim.
 */

export function getSettingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

export type ModelThinkingLevels = Record<string, string>;

/** Read settings.json, tolerating a missing or malformed file. */
export async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The `modelThinkingLevels` map, with non-string values dropped. */
export async function getModelThinkingLevels(path: string): Promise<ModelThinkingLevels> {
  const settings = await readSettings(path);
  const raw = settings["modelThinkingLevels"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: ModelThinkingLevels = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim().length > 0) result[key] = value;
  }
  return result;
}

export function thinkingKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** Effective depth for a model, defaulting to `medium`. */
export async function getModelThinkingLevel(
  path: string,
  provider: string,
  modelId: string,
): Promise<string> {
  const levels = await getModelThinkingLevels(path);
  return levels[thinkingKey(provider, modelId)] ?? DEFAULT_THINKING_LEVEL;
}

/** Merge one `provider/modelId -> level` entry into settings.json. */
export async function setModelThinkingLevel(
  path: string,
  provider: string,
  modelId: string,
  level: string,
): Promise<void> {
  await setModelThinkingLevels(path, { [thinkingKey(provider, modelId)]: level });
}

/** Merge many `provider/modelId -> level` entries in a single write. */
export async function setModelThinkingLevels(
  path: string,
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const settings = await readSettings(path);
  const raw = settings["modelThinkingLevels"];
  const existing =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...settings, modelThinkingLevels: { ...existing, ...entries } }, null, 2)}\n`,
    "utf8",
  );
}
