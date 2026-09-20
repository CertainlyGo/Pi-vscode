/**
 * Activation smoke test: load the built extension with a mocked `vscode` module
 * and make sure `activate()` wires up views and commands without throwing.
 *
 *   npm run smoke:extension
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

/* ------------------------------- vscode mock ------------------------------ */

const registeredCommands = new Map();
let viewProvider;

class EventEmitter {
  constructor() {
    this.event = () => ({ dispose() {} });
  }
  dispose() {}
  fire() {}
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

const noopDisposable = { dispose() {} };

const workspaceConfiguration = {
  get: (_key, fallback) => fallback,
  affectsConfiguration: () => false,
};

const vscodeMock = {
  EventEmitter,
  Position,
  Range,
  Uri: {
    file: (fsPath) => ({ scheme: "file", fsPath, path: fsPath, toString: () => fsPath }),
    from: (parts) => ({ ...parts, fsPath: parts.path ?? "", toString: () => parts.path ?? "" }),
    joinPath: (base, ...segments) => ({
      scheme: base.scheme ?? "file",
      path: [base.path ?? "", ...segments].join("/"),
      fsPath: [base.fsPath ?? "", ...segments].join("/"),
      toString: () => [base.path ?? "", ...segments].join("/"),
    }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => workspaceConfiguration,
    onDidChangeWorkspaceFolders: () => noopDisposable,
    onDidChangeConfiguration: () => noopDisposable,
    registerTextDocumentContentProvider: () => noopDisposable,
    findFiles: async () => [],
    asRelativePath: (uri) => uri.fsPath ?? String(uri),
    openTextDocument: async () => ({}),
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: (id, provider) => {
      assert.equal(id, "pi.chat");
      viewProvider = provider;
      return noopDisposable;
    },
    showInformationMessage: async () => undefined,
    showTextDocument: async () => ({}),
  },
  commands: {
    registerCommand: (id, callback) => {
      registeredCommands.set(id, callback);
      return noopDisposable;
    },
    executeCommand: async () => undefined,
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

/* --------------------------------- run it -------------------------------- */

const extension = require(resolve("dist/extension.js"));

const context = {
  subscriptions: [],
  extensionUri: { scheme: "file", path: "/ext", fsPath: "/ext" },
  extensionPath: resolve("."),
};

extension.activate(context);
assert.ok(viewProvider !== undefined, "webview view provider was registered");

const expectedCommands = [
  "pi.newSession",
  "pi.focusChat",
  "pi.abort",
  "pi.restartEngine",
  "pi.showLogs",
  "pi.addSelectionToChat",
  "pi.addFileToChat",
];
for (const command of expectedCommands) {
  assert.ok(registeredCommands.has(command), `command ${command} was registered`);
}

// Resolve a fake webview view and check the generated HTML.
const html = resolvedViewHtml();
assert.match(html, /dist\/webview\.js/);
assert.match(html, /dist\/webview\.css/);
assert.match(html, /Content-Security-Policy/);
assert.match(html, /nonce-/);

// Command-palette handlers must not throw with no workspace open.
for (const [id, callback] of registeredCommands) {
  await callback();
  void id;
}

extension.deactivate();
for (const disposable of context.subscriptions) disposable.dispose?.();

Module._load = originalLoad;
console.log(`[smoke:extension] OK — ${registeredCommands.size} commands, view provider active`);

/**
 * The view provider stores the html on the fake view object; read it back.
 * `resolveWebviewView` assigns `view.webview.html`, but our fake object is a
 * literal, so we re-resolve with a tracked object instead.
 */
function resolvedViewHtml() {
  let captured = "";
  viewProvider.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      cspSource: "vscode-webview://test",
      set html(value) {
        captured = value;
      },
      get html() {
        return captured;
      },
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage: () => noopDisposable,
      postMessage: async () => true,
    },
    onDidChangeVisibility: () => noopDisposable,
    onDidDispose: () => noopDisposable,
    show() {},
  });
  return captured;
}
