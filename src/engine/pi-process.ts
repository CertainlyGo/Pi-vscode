import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { EngineExitInfo, EngineProcess } from "./engine-instance";

export interface SpawnOptions {
  /** Executable to run (a node binary, or a `pi` shim/binary). */
  readonly command: string;
  /** Arguments for the executable, not including `--mode rpc`. */
  readonly args: readonly string[];
  /** Engine cwd — the workspace folder. */
  readonly cwd: string;
  /** Extra environment, merged over `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Appended after `--mode rpc`. */
  readonly extraArgs?: readonly string[];
}

/**
 * Spawn `pi --mode rpc` and adapt the child process to {@link EngineProcess}.
 *
 * On POSIX the child is detached into its own process group so `killTree` can
 * take down the whole tree with `kill(-pid)`. On Windows we fall back to
 * `taskkill /T /F`.
 */
export function spawnPiEngine(options: SpawnOptions): EngineProcess {
  const args = [...options.args, "--mode", "rpc", ...(options.extraArgs ?? [])];
  const child = spawn(options.command, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  return new ChildProcessAdapter(child);
}

class ChildProcessAdapter implements EngineProcess {
  readonly pid: number | undefined;
  readonly #child: ChildProcess;
  readonly #stdin: NodeJS.WritableStream;
  readonly #stdoutDecoder = new StringDecoder("utf8");
  readonly #stderrDecoder = new StringDecoder("utf8");
  readonly #stdoutListeners: Array<(chunk: string) => void> = [];
  readonly #stderrListeners: Array<(chunk: string) => void> = [];
  readonly #exitListeners: Array<(info: EngineExitInfo) => void> = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];

  constructor(child: ChildProcess) {
    this.#child = child;
    this.pid = child.pid;
    if (child.stdout === null || child.stderr === null || child.stdin === null) {
      throw new Error("engine child has no stdio (bad spawn configuration)");
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    this.#stdin = child.stdin;
    stdout.on("data", (chunk: Buffer) => {
      const text = this.#stdoutDecoder.write(chunk);
      for (const listener of this.#stdoutListeners) listener(text);
    });
    stderr.on("data", (chunk: Buffer) => {
      const text = this.#stderrDecoder.write(chunk);
      for (const listener of this.#stderrListeners) listener(text);
    });
    child.on("exit", (code, signal) => {
      for (const listener of this.#exitListeners) listener({ code, signal });
    });
    child.on("error", (error) => {
      for (const listener of this.#errorListeners) listener(error);
    });
  }

  write(record: string): void {
    this.#stdin.write(record);
  }

  endInput(): void {
    this.#stdin.end();
  }

  kill(): void {
    this.#child.kill();
  }

  killTree(): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      void spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process group may already be gone.
      }
    }
  }

  onStdout(listener: (chunk: string) => void): void {
    this.#stdoutListeners.push(listener);
  }

  onStderr(listener: (chunk: string) => void): void {
    this.#stderrListeners.push(listener);
  }

  onExit(listener: (info: EngineExitInfo) => void): void {
    this.#exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListeners.push(listener);
  }
}
