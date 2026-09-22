import { exec } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CLI_RELATIVE = join("dist", "bundle", "cli.js");

export interface PiLaunch {
  /** Executable to run. */
  readonly command: string;
  /** Arguments before `--mode rpc`. */
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Human-readable description for logs and error messages. */
  readonly describe: string;
  /** Resolved pi version, when we can read it. */
  readonly version?: string;
  /** Root of the resolved pi package, used to locate the pi-ai OAuth loaders. */
  readonly packageDir?: string;
  readonly source: "setting" | "package" | "path";
}

export interface LocatePiOptions {
  /** Value of `pi.executablePath`. */
  readonly executablePath?: string;
  /** Workspace folder, for resolving relative settings. */
  readonly workspace: string;
  /** Directory that may contain a bundled node_modules (the extension folder). */
  readonly extensionPath?: string;
}

/**
 * Find a way to launch `pi --mode rpc`.
 *
 * Order:
 *  1. explicit `pi.executablePath` setting;
 *  2. a resolvable `@earendil-works/pi-coding-agent` package (bundled, global
 *     npm root, or well-known global directories), run with a Node binary;
 *  3. the `pi` shim found on PATH.
 */
export async function locatePi(options: LocatePiOptions): Promise<PiLaunch> {
  const configured = options.executablePath?.trim();
  if (configured !== undefined && configured.length > 0) {
    const launch = await fromSetting(configured, options.workspace);
    if (launch !== undefined) return launch;
  }

  const packageCli = await findPackageCli(options.extensionPath);
  if (packageCli !== undefined) {
    const node = await resolveNodeBinary();
    return {
      command: node.command,
      args: [packageCli.cliPath],
      env: node.env,
      describe: `${node.command} ${packageCli.cliPath}`,
      ...(packageCli.version !== undefined ? { version: packageCli.version } : {}),
      packageDir: packageCli.packageDir,
      source: "package",
    };
  }

  const shim = findOnPath(process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"]);
  if (shim !== undefined) {
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(shim)) {
      return {
        command: process.env["ComSpec"] ?? "cmd.exe",
        args: ["/d", "/s", "/c", shim],
        env: {},
        describe: shim,
        source: "path",
      };
    }
    return { command: shim, args: [], env: {}, describe: shim, source: "path" };
  }

  throw new Error(
    [
      "Could not find the pi CLI.",
      "Install it with `npm install -g @earendil-works/pi-coding-agent`,",
      "or set `pi.executablePath` to the pi executable (or to its dist/bundle/cli.js).",
    ].join(" "),
  );
}

async function fromSetting(raw: string, workspace: string): Promise<PiLaunch | undefined> {
  const expanded = expandHome(raw);
  const candidate = isAbsolute(expanded) ? expanded : resolve(workspace, expanded);
  if (!existsSync(candidate)) return undefined;

  const stat = statSync(candidate);
  const cliPath = stat.isDirectory() ? join(candidate, CLI_RELATIVE) : candidate;
  if (!existsSync(cliPath)) return undefined;

  if (/\.(js|mjs|cjs)$/i.test(cliPath)) {
    const node = await resolveNodeBinary();
    const packageDir = dirname(dirname(dirname(cliPath)));
    return {
      command: node.command,
      args: [cliPath],
      env: node.env,
      describe: `${node.command} ${cliPath}`,
      packageDir,
      ...(readVersion(packageDir) ?? {}),
      source: "setting",
    };
  }

  return { command: cliPath, args: [], env: {}, describe: cliPath, source: "setting" };
}

interface PackageCli {
  readonly cliPath: string;
  readonly packageDir: string;
  readonly version?: string;
}

async function findPackageCli(extensionPath?: string): Promise<PackageCli | undefined> {
  const roots: string[] = [];
  if (extensionPath !== undefined) roots.push(join(extensionPath, "node_modules"));
  if (process.env["PI_PACKAGE_ROOT"] !== undefined) roots.push(process.env["PI_PACKAGE_ROOT"]);

  const globalRoot = await globalNpmRoot();
  if (globalRoot !== undefined) roots.push(globalRoot);
  roots.push(...wellKnownGlobalRoots());

  for (const root of roots) {
    const pkgDir = join(root, ...PACKAGE_NAME.split("/"));
    const cliPath = join(pkgDir, CLI_RELATIVE);
    if (existsSync(cliPath)) {
      return { cliPath, packageDir: pkgDir, ...(readVersion(pkgDir) ?? {}) };
    }
  }
  return undefined;
}

async function globalNpmRoot(): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync("npm root -g", {
      timeout: 10_000,
      windowsHide: true,
    });
    const root = stdout.trim().split(/\r?\n/).pop()?.trim();
    return root !== undefined && root.length > 0 && existsSync(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

function wellKnownGlobalRoots(): string[] {
  const home = homedir();
  const roots = [
    join(home, ".npm-global", "lib", "node_modules"),
    join(home, ".local", "share", "npm", "lib", "node_modules"),
    join(home, "AppData", "Roaming", "npm", "node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
  ];
  const nodePath = process.env["NODE_PATH"];
  if (nodePath !== undefined) roots.push(...nodePath.split(delimiter).filter((part) => part.length > 0));
  return roots;
}

interface NodeBinary {
  readonly command: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * Prefer a real Node on PATH (pi requires Node >= 22.19); otherwise fall back
 * to the Electron binary running as Node via ELECTRON_RUN_AS_NODE.
 */
async function resolveNodeBinary(): Promise<NodeBinary> {
  const override = process.env["PI_NODE_PATH"];
  if (override !== undefined && override.trim().length > 0) {
    return { command: override.trim(), env: {} };
  }

  const node = findOnPath(process.platform === "win32" ? ["node.exe", "node"] : ["node"]);
  if (node !== undefined) {
    return { command: node, env: {} };
  }

  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function readVersion(pkgDir: string): { version: string } | undefined {
  try {
    const raw = readFileSync(join(pkgDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? { version: parsed.version } : undefined;
  } catch {
    return undefined;
  }
}

function findOnPath(names: readonly string[]): string | undefined {
  const pathValue = process.env["PATH"] ?? process.env["Path"] ?? "";
  const dirs = pathValue.split(delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return undefined;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}
