import * as vscode from "vscode";

/**
 * Serves read-only virtual documents for tool diffs.
 *
 * `pi-diff:/<id>` renders the stored text with the built-in `diff` language, so
 * VS Code colours additions/deletions without us writing a custom editor.
 */
export class PiDiffProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "pi-diff";

  readonly #store = new Map<string, string>();
  #counter = 0;
  readonly #emitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.#emitter.event;

  /** Store content and return a URI that serves it. */
  create(content: string, label: string): vscode.Uri {
    this.#counter += 1;
    const id = `${this.#counter}-${sanitize(label)}`;
    this.#store.set(id, content);
    return vscode.Uri.from({ scheme: PiDiffProvider.scheme, path: `/${id}` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#store.get(uri.path.replace(/^\//, "")) ?? "";
  }

  dispose(): void {
    this.#store.clear();
    this.#emitter.dispose();
  }
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40);
}
