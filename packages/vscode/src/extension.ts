import { defineCpgConfig, indexWorkspace, openCpgStore, WebTreeSitterBackend } from "@cpg/engine";
import * as vscode from "vscode";

import {
  activationSummary,
  chooseWorkspaceFolder,
  explicitDbOverrides,
  indexReportLines,
  indexSummary,
  INDEX_WORKSPACE_COMMAND,
  LOG_CHANNEL_NAME,
  nextProgressTick,
  SHOW_LOG_COMMAND,
  SHOW_VERSION_COMMAND,
  surfaceIndexError,
  versionMessage,
  type CpgSettingsSnapshot,
} from "./index.js";

let channel: vscode.LogOutputChannel | undefined;
/** Folder name currently being indexed, or `undefined`. One run at a time —
 *  two per-file replaces against the same graph key would interleave
 *  delete/create ops. */
let indexingFolder: string | undefined;

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
    vscode.commands.registerCommand(INDEX_WORKSPACE_COMMAND, (uri?: vscode.Uri) =>
      handleIndexWorkspace(uri, channel!),
    ),
  );
}

export function deactivate(): void {
  // context.subscriptions disposes the channel after this returns; log while
  // it is still live. There is no server connection to close yet.
  channel?.info("@cpg/vscode deactivating.");
}

function readCpgSettings(): CpgSettingsSnapshot {
  const config = vscode.workspace.getConfiguration("cpg.engine.db");
  return {
    mode: config.inspect<string>("mode"),
    host: config.inspect<string>("host"),
    port: config.inspect<number>("port"),
    graph: config.inspect<string>("graph"),
  };
}

async function handleErrorAction(
  action: string | undefined,
  channelRef: vscode.LogOutputChannel,
): Promise<void> {
  if (action === "Show Log") {
    channelRef.show();
  } else if (action === "Copy start command") {
    await vscode.env.clipboard.writeText("bun run db:dev:up");
  } else if (action === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "cpg.engine.db");
  }
}

async function handleIndexWorkspace(
  uri: vscode.Uri | undefined,
  channelRef: vscode.LogOutputChannel,
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage("CPG: indexing requires a trusted workspace.");
    return;
  }

  const openFolders = vscode.workspace.workspaceFolders ?? [];
  const preselected =
    uri !== undefined ? vscode.workspace.getWorkspaceFolder(uri)?.name : undefined;
  const choice = chooseWorkspaceFolder(
    openFolders.map((f) => f.name),
    preselected,
  );

  let folder: vscode.WorkspaceFolder | undefined;
  if (choice.kind === "none") {
    void vscode.window.showErrorMessage("CPG: open a folder before indexing.");
    return;
  } else if (choice.kind === "one") {
    folder = openFolders[choice.index];
  } else {
    folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Index which folder?" });
    if (folder === undefined) {
      return; // Dismissed.
    }
  }
  if (folder === undefined) {
    return;
  }

  if (indexingFolder !== undefined) {
    const action = await vscode.window.showWarningMessage(
      `CPG: already indexing ${indexingFolder}.`,
      "Show Log",
    );
    await handleErrorAction(action, channelRef);
    return;
  }

  indexingFolder = folder.name;
  try {
    await runIndexWorkspace(folder, channelRef);
  } finally {
    indexingFolder = undefined;
  }
}

async function runIndexWorkspace(
  folder: vscode.WorkspaceFolder,
  channelRef: vscode.LogOutputChannel,
): Promise<void> {
  const config = defineCpgConfig({
    root: folder.uri.fsPath,
    db: explicitDbOverrides(readCpgSettings()),
  });
  const where = { host: config.falkor.connection.host, port: config.falkor.connection.port };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CPG: indexing ${folder.name}`,
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      const backend = new WebTreeSitterBackend();
      try {
        const opened = await openCpgStore(config.falkor);
        try {
          let last = { percent: 0, atMs: Date.now() };
          const report = await indexWorkspace(
            config,
            { store: opened.store, backend },
            {
              signal: controller.signal,
              onWarning: (w) => channelRef.warn(w.message),
              // Lets the extension host drain its event loop between files —
              // parsing is synchronous CPU work shared with every other
              // extension. Does not reduce total CPU; the documented
              // upgrade path for real repo scale is a worker_threads Worker,
              // not a CLI subprocess (indexWorkspace's boundary is already
              // plain data + AbortSignal, so that move needs no API change).
              yieldBetweenFiles: () => new Promise((resolve) => setImmediate(resolve)),
              onProgress: (p) => {
                const now = Date.now();
                const tick = nextProgressTick(p, last, now);
                if (tick !== undefined) {
                  last = { percent: last.percent + tick.increment, atMs: now };
                  progress.report({ message: tick.message, increment: tick.increment });
                }
              },
            },
          );

          for (const line of indexReportLines(report)) {
            channelRef.info(line);
          }
          void vscode.window.showInformationMessage(indexSummary(report));
        } finally {
          await opened.close();
        }
      } catch (error) {
        const surfaced = surfaceIndexError(error, where);
        channelRef.error(surfaced.detail.join("\n"));
        const action = await vscode.window.showErrorMessage(surfaced.message, ...surfaced.actions);
        await handleErrorAction(action, channelRef);
      } finally {
        backend.dispose();
      }
    },
  );
}
