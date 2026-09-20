import type { EngineInstance } from "./engine-instance";

export interface EngineRegistryOptions {
  /** Build a fully wired (but not started) engine for a workspace. */
  readonly create: (workspace: string) => EngineInstance;
  /** How often to look for idle engines. 0 disables reaping. */
  readonly reapIntervalMs?: number;
}

/**
 * Keeps at most one {@link EngineInstance} per workspace and recycles idle
 * ones. Starting is the caller's job (see ChatController.ensureEngine) so the
 * registry stays a plain lifecycle map.
 */
export class EngineRegistry {
  readonly #engines = new Map<string, EngineInstance>();
  readonly #create: (workspace: string) => EngineInstance;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: EngineRegistryOptions) {
    this.#create = options.create;
    const interval = options.reapIntervalMs ?? 0;
    if (interval > 0) {
      this.#timer = setInterval(() => void this.#reap(), interval);
      this.#timer.unref();
    }
  }

  get(workspace: string): EngineInstance | undefined {
    return this.#engines.get(workspace);
  }

  /** Return the engine for a workspace, creating it if needed. */
  ensure(workspace: string): EngineInstance {
    const existing = this.#engines.get(workspace);
    if (existing !== undefined) return existing;
    const created = this.#create(workspace);
    this.#engines.set(workspace, created);
    return created;
  }

  async stop(workspace: string): Promise<void> {
    const engine = this.#engines.get(workspace);
    if (engine === undefined) return;
    this.#engines.delete(workspace);
    await engine.stop();
  }

  async stopAll(): Promise<void> {
    const engines = [...this.#engines.values()];
    this.#engines.clear();
    await Promise.all(engines.map((engine) => engine.stop().catch(() => undefined)));
  }

  dispose(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #reap(): Promise<void> {
    for (const [workspace, engine] of [...this.#engines]) {
      if (engine.isIdle()) await this.stop(workspace);
    }
  }
}
