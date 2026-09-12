import * as vscode from "vscode";

import { SHOW_VERSION_COMMAND, versionMessage } from "./index.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_VERSION_COMMAND, () => {
      void vscode.window.showInformationMessage(versionMessage());
    }),
  );
}

export function deactivate(): void {
  // Nothing to tear down yet.
}
