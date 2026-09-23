import { basename } from "node:path";
import * as vscode from "vscode";
import { ChatController } from "./chat/chat-controller";
import { ChatView } from "./chat/chat-view";
import { PiDiffProvider } from "./chat/diff-provider";
import type { Attachment } from "./shared/protocol";

export function activate(context: vscode.ExtensionContext): void {
  const diff = new PiDiffProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PiDiffProvider.scheme, diff),
  );

  let controller: ChatController;
  const view = new ChatView(context.extensionUri, {
    onMessage: (message) => void controller.handleMessage(message),
    onReady: () => void controller.onViewReady(),
    onVisibilityChange: () => undefined,
  });

  controller = new ChatController({ context, view, diff });

  context.subscriptions.push(
    controller,
    diff,
    vscode.window.registerWebviewViewProvider(ChatView.viewType, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("pi.newSession", async () => {
      await view.reveal();
      await controller.newSession();
    }),
    vscode.commands.registerCommand("pi.focusChat", async () => {
      await view.reveal();
    }),
    vscode.commands.registerCommand("pi.openProviders", () => controller.openProviders()),
    vscode.commands.registerCommand("pi.abort", () => controller.abort()),
    vscode.commands.registerCommand("pi.compact", () => controller.compact()),
    vscode.commands.registerCommand("pi.restartEngine", () => controller.restart()),
    vscode.commands.registerCommand("pi.showLogs", () => controller.showLogs()),
    vscode.commands.registerCommand("pi.addSelectionToChat", async () => {
      const attachment = selectionAttachment();
      if (attachment === undefined) {
        void vscode.window.showInformationMessage("pi: select some code first.");
        return;
      }
      await controller.attach(attachment);
    }),
    vscode.commands.registerCommand("pi.addFileToChat", async () => {
      const attachment = activeFileAttachment();
      if (attachment === undefined) {
        void vscode.window.showInformationMessage("pi: no active editor.");
        return;
      }
      await controller.attach(attachment);
    }),
  );
}

export function deactivate(): void {
  // Disposables registered in activate() handle cleanup.
}

function selectionAttachment(): Attachment | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty) return undefined;
  const selection = editor.selection;
  const path = vscode.workspace.asRelativePath(editor.document.uri, false);
  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  return {
    kind: "selection",
    path,
    label: `${basename(editor.document.uri.fsPath)}:${startLine}-${endLine}`,
    text: editor.document.getText(selection),
    startLine,
    endLine,
  };
}

function activeFileAttachment(): Attachment | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return undefined;
  const path = vscode.workspace.asRelativePath(editor.document.uri, false);
  return { kind: "file", path, label: path };
}
