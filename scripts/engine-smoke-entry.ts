import { EngineInstance } from "../src/engine/engine-instance";
import { locatePi } from "../src/engine/locate-pi";
import { spawnPiEngine } from "../src/engine/pi-process";

const workspace = process.cwd();
const launch = await locatePi({ workspace, extensionPath: process.cwd() });
console.log(`[smoke] pi launch (${launch.source}): ${launch.describe}`);

const seen = new Set<string>();
const engine = new EngineInstance({
  workspace,
  start: () =>
    spawnPiEngine({ command: launch.command, args: launch.args, cwd: workspace, env: launch.env }),
  onEvent: (message) => {
    const type = message !== null && typeof message === "object" ? message.type : undefined;
    if (typeof type === "string") seen.add(type);
  },
  onWarning: (error) => console.error(`[smoke] warning: ${error.message}`),
});

try {
  await engine.start();
  console.log(`[smoke] engine ready (pid=${engine.pid ?? "?"})`);

  const state = await engine.getState();
  console.log(`[smoke] state: model=${state?.model?.id ?? "none"} streaming=${state?.isStreaming}`);

  const models = await engine.listModels();
  console.log(`[smoke] models: ${models.length}`);

  const levels = await engine.listThinkingLevels();
  console.log(`[smoke] thinking levels: ${levels.join(", ")}`);

  const commands = await engine.getCommands();
  console.log(`[smoke] commands: ${commands.length}`);

  const forks = await engine.getForkMessages();
  console.log(`[smoke] forkable messages: ${forks.length}`);

  const stats = await engine.getSessionStats();
  console.log(`[smoke] stats: ${stats === undefined ? "none" : JSON.stringify(stats.tokens)}`);

  console.log(`[smoke] events seen: ${[...seen].sort().join(", ") || "none"}`);
  console.log("[smoke] OK");
} finally {
  await engine.stop();
}
