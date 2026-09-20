import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "../shared/protocol";

export interface ChatViewCallbacks {
  readonly onMessage: (message: WebviewMessage) => void;
  readonly onReady: () => void;
  readonly onVisibilityChange: (visible: boolean) => void;
}

/**
 * The sidebar chat webview. Owns nothing but the webview lifecycle and the
 * message pipe; all state lives in {@link ChatController}.
 */
export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewType = "pi.chat";

  readonly #extensionUri: vscode.Uri;
  readonly #callbacks: ChatViewCallbacks;
  #view: vscode.WebviewView | undefined;
  #ready = false;
  /** Messages posted before the webview finished booting. */
  #pending: HostMessage[] = [];

  constructor(extensionUri: vscode.Uri, callbacks: ChatViewCallbacks) {
    this.#extensionUri = extensionUri;
    this.#callbacks = callbacks;
  }

  get visible(): boolean {
    return this.#view?.visible === true;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    this.#ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.#extensionUri, "dist")],
    };
    view.webview.html = this.#html(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      const parsed = message as WebviewMessage;
      if (parsed?.type === "ready") {
        this.#ready = true;
        for (const pending of this.#pending) void view.webview.postMessage(pending);
        this.#pending = [];
        this.#callbacks.onReady();
        return;
      }
      this.#callbacks.onMessage(parsed);
    });

    view.onDidChangeVisibility(() => this.#callbacks.onVisibilityChange(view.visible));
    view.onDidDispose(() => {
      this.#view = undefined;
      this.#ready = false;
    });
  }

  post(message: HostMessage): void {
    const view = this.#view;
    if (view === undefined) return;
    if (!this.#ready) {
      // Bound the backlog so a never-opened view cannot grow without limit.
      if (this.#pending.length > 200) this.#pending.shift();
      this.#pending.push(message);
      return;
    }
    void view.webview.postMessage(message);
  }

  async reveal(): Promise<void> {
    if (this.#view !== undefined) {
      this.#view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand(`${ChatView.viewType}.focus`);
  }

  #html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.#extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.#extensionUri, "dist", "webview.css"),
    );
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>pi</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}
