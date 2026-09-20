/**
 * Headless smoke test: bundle the engine bridge (no `vscode` dependency) and
 * drive a real `pi --mode rpc` process through start -> query -> stop.
 *
 *   npm run smoke
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const outfile = resolve("dist/engine-smoke.mjs");

await build({
  entryPoints: ["scripts/engine-smoke-entry.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(outfile, { force: true });
}
