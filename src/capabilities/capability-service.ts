import { readFile } from "node:fs/promises";
import type { PluginInfo, SkillInfo } from "../shared/protocol";

/**
 * Read-only discovery of what pi can do in this workspace: skills (exposed by
 * pi as `skill:*` commands) and plugins (packages, local extensions and the
 * extension commands they register). pi's TUI-only `/skills` and `/plugins`
 * commands are not reachable over RPC, so the extension renders its own view.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a pi settings file, tolerating a missing or malformed file. */
export async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
  try {
    return asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return {};
  }
}

/** Skills are surfaced by pi's `get_commands` with a `skill` source. */
export function skillsFromCommands(commands: readonly Record<string, unknown>[]): SkillInfo[] {
  const skills: SkillInfo[] = [];
  for (const command of commands) {
    if (str(command["source"]) !== "skill") continue;
    const raw = str(command["name"]);
    if (raw === undefined) continue;
    const description = str(command["description"]);
    const location = str(command["location"]);
    const path = str(command["path"]);
    skills.push({
      name: raw.replace(/^skill:/, ""),
      ...(description !== undefined ? { description } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(path !== undefined ? { path } : {}),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PluginSources {
  readonly userSettings: Record<string, unknown>;
  readonly projectSettings: Record<string, unknown>;
  /** pi's `get_commands` payload, used to see which extensions registered what. */
  readonly commands: readonly Record<string, unknown>[];
}

/** Packages, local extensions and extension commands, de-duplicated. */
export function pluginsFromSettings(sources: PluginSources): PluginInfo[] {
  const byKey = new Map<string, PluginInfo>();
  const extensionPaths = new Set<string>();

  const add = (key: string, entry: PluginInfo): void => {
    const existing = byKey.get(key);
    // pi lets project settings override user settings for the same resource.
    if (existing === undefined || (entry.scope === "project" && existing.scope !== "project")) {
      byKey.set(key, entry);
    }
  };

  for (const [scope, settings] of [
    ["user", sources.userSettings],
    ["project", sources.projectSettings],
  ] as const) {
    for (const make of packagesOf(settings)) {
      const entry = make(scope);
      add(`package:${entry.name}`, entry);
    }
    for (const path of stringArray(settings["extensions"])) {
      extensionPaths.add(path);
      add(`extension:${path}`, { name: path, kind: "extension", scope, path });
    }
  }

  for (const command of sources.commands) {
    if (str(command["source"]) !== "extension") continue;
    const name = str(command["name"]);
    if (name === undefined) continue;
    const path = str(command["path"]);
    // Already listed from settings; do not show the same file twice.
    if (path !== undefined && extensionPaths.has(path)) continue;
    const description = str(command["description"]);
    add(`command:${path ?? name}`, {
      name: `/${name}`,
      kind: "command",
      scope: "runtime",
      ...(description !== undefined ? { detail: description } : {}),
      ...(path !== undefined ? { path } : {}),
    });
  }

  const order: Record<string, number> = { package: 0, extension: 1, command: 2 };
  return [...byKey.values()].sort(
    (a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.name.localeCompare(b.name),
  );
}

function packagesOf(settings: Record<string, unknown>): ((scope: string) => PluginInfo)[] {
  const packages = settings["packages"];
  if (!Array.isArray(packages)) return [];
  const result: ((scope: string) => PluginInfo)[] = [];
  for (const entry of packages) {
    if (typeof entry === "string") {
      result.push((scope) => ({ name: entry, kind: "package", scope }));
      continue;
    }
    const record = asRecord(entry);
    const source = str(record["source"]);
    if (source === undefined) continue;
    const filters = (["extensions", "skills", "prompts", "themes"] as const).filter((key) =>
      Array.isArray(record[key]),
    );
    const detail = filters.length > 0 ? `filtered: ${filters.join(", ")}` : "all resources";
    result.push((scope) => ({ name: source, kind: "package", scope, detail }));
  }
  return result;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
