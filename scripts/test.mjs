/**
 * Bundle the tests with esbuild (the sources use extensionless imports, which
 * Node's type stripping cannot resolve) and run them with `node --test`.
 */
import { build } from "esbuild";
import { readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const outdir = resolve("dist/tests");
await rm(outdir, { recursive: true, force: true });

const entries = (await readdir("test"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `test/${name}`);

await build({
  entryPoints: entries,
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"test"' },
  logLevel: "warning",
});

const files = (await readdir(outdir)).filter((name) => name.endsWith(".mjs")).map((name) => `${outdir}/${name}`);
const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
