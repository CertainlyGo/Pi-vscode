import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** Extension host bundle: Node/CJS, `vscode` is provided by the host. */
const extension = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
};

/** Webview bundle: browser/IIFE, CSS imported from the entry is emitted next to it. */
const webview = {
  entryPoints: ["media/src/main.tsx"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
  sourcemap: true,
  minify: !watch,
  loader: {
    ".ttf": "file",
  },
  logLevel: "info",
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("watching…");
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
