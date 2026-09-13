import * as vscode from "vscode";

import {
  activationSummary,
  LOG_CHANNEL_NAME,
  SHOW_LOG_COMMAND,
  SHOW_VERSION_COMMAND,
  versionMessage,
} from "./index.js";

let channel: vscode.LogOutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME, { log: true });
  context.subscriptions.push(channel);

  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name);
  for (const line of activationSummary({ workspaceFolders: folders })) {
    channel.info(line);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_VERSION_COMMAND, () => {
      void vscode.window.showInformationMessage(versionMessage());
    }),
    vscode.commands.registerCommand(SHOW_LOG_COMMAND, () => {
      channel?.show();
    }),
  );
}

export function deactivate(): void {
  // context.subscriptions disposes the channel after this returns; log while
  // it is still live. There is no server connection to close yet.
  channel?.info("@cpg/vscode deactivating.");
}
