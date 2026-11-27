// REAL (U3.1.1 part 4, BMO-52): the VS Code extension's composition root. Glue only: every flow lives
// in plain-node modules and adapters/. Driven with a vscode stand-in by tools/extension.test.mjs.

import { join } from 'node:path';
import { createEngine } from '@cpg/engine';
import type { WorkspacePath } from '@cpg/model';
import * as vscode from 'vscode';
import { workspaceFileSystem } from './adapters/filesystem-probe';
import { createSourceOpener } from './adapters/source-opener';
import {
  createGraphPanel,
  GRAPH_VIEW_TYPE,
  graphPanelSerializer,
} from './adapters/webview-transport';
import { GraphSession } from './graph-session';
import { pageDirectory } from './panel-page';
import { panelTheme } from './theme';
import {
  statusBarView,
  verificationDiagnostics,
  type VerificationDiagnostic,
} from './verification-view';

function toDiagnostic({ message, checkId }: VerificationDiagnostic): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message);
  diagnostic.source = 'cpg';
  diagnostic.code = checkId;
  return diagnostic;
}

/** The command that shows the log, and the button an error offers for it. */
const SHOW_LOG = 'cpg.showLog';

export function activate(context: vscode.ExtensionContext): void {
  // Output > CPG. Timestamped; its level follows "Developer: Set Log Level..." (default info).
  const log = vscode.window.createOutputChannel('CPG', { log: true });
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const uriOf = (path: WorkspacePath): vscode.Uri => vscode.Uri.file(join(root ?? '', path));
  const version = String(context.extension.packageJSON.version);
  const directory = pageDirectory();
  log.info(
    `activated: cpg ${version} in VS Code ${vscode.version}; workspace ${root ?? '(none)'}; page bundle ${directory}`,
  );

  const statusBar = vscode.window.createStatusBarItem('cpg.verify', vscode.StatusBarAlignment.Left);
  statusBar.command = 'cpg.verify';
  const diagnostics = vscode.languages.createDiagnosticCollection('cpg');

  const session = new GraphSession({
    root,
    version,
    createEngine,
    fileSystem: workspaceFileSystem(uriOf),
    opener: createSourceOpener(uriOf),
    theme: panelTheme(vscode.window.activeColorTheme.kind),
    createPanel: () => createGraphPanel(directory),
    pageDirectory: directory,
    after: (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    onReport: (report) => {
      const { text, tooltip } = statusBarView(report);
      statusBar.text = text;
      statusBar.tooltip = tooltip;
      statusBar.show();
      diagnostics.clear();
      // VS Code merges the entries of one file.
      diagnostics.set(
        verificationDiagnostics(report).map((entry) => [
          uriOf(entry.filePath),
          [toDiagnostic(entry)],
        ]),
      );
    },
    showWarning: (text) => {
      void vscode.window.showWarningMessage(text);
    },
    showError: (text) => {
      void vscode.window.showErrorMessage(text, 'Show Log').then((choice) => {
        if (choice !== undefined) log.show(true);
      });
    },
    log,
  });

  // Never put the panel itself in subscriptions: VS Code restores it after a reload.
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand(SHOW_LOG, () => log.show(true)),
    statusBar,
    diagnostics,
    session,
    vscode.commands.registerCommand('cpg.openGraph', () => session.openGraph()),
    vscode.commands.registerCommand('cpg.verify', () => session.verify()),
    vscode.commands.registerCommand('cpg.rescan', () => session.rescan()),
    vscode.window.registerWebviewPanelSerializer(
      GRAPH_VIEW_TYPE,
      graphPanelSerializer(directory, (surface) => session.restorePanel(surface)),
    ),
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      session.setTheme(panelTheme(theme.kind));
    }),
  );
}
