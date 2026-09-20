import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CONFIG_DIR_NAME = ".pi";
const TRUST_REQUIRING_ENTRIES = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
];

function canonical(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Mirrors pi's `hasTrustRequiringProjectResources`: does this workspace (or an
 * ancestor) carry project-local resources that pi gates behind trust?
 */
export function needsTrust(cwd: string): boolean {
  const home = canonical(process.env["HOME"] ?? homedir());
  const userSkills = join(home, ".agents", "skills");
  let current = canonical(cwd);
  const configDir = join(current, CONFIG_DIR_NAME);
  if (TRUST_REQUIRING_ENTRIES.some((entry) => existsSync(join(configDir, entry)))) return true;
  for (;;) {
    const agentsSkills = join(current, ".agents", "skills");
    if (agentsSkills !== userSkills && existsSync(agentsSkills)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

interface TrustFile {
  [path: string]: boolean;
}

function trustPath(agentDir: string): string {
  return join(resolve(agentDir), "trust.json");
}

function readTrustFile(path: string): TrustFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const result: TrustFile = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true || value === false) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** Nearest stored decision for this workspace, or null when undecided. */
export function readTrustDecision(agentDir: string, cwd: string): boolean | null {
  const data = readTrustFile(trustPath(agentDir));
  let current = canonical(cwd);
  for (;;) {
    const value = data[current];
    if (value === true || value === false) return value;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Persist a trust decision into pi's own `trust.json`. */
export function writeTrustDecision(agentDir: string, cwd: string, decision: boolean): void {
  const path = trustPath(agentDir);
  const data = readTrustFile(path);
  data[canonical(cwd)] = decision;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
