import * as vscode from 'vscode';
import { ChainResolver, PythonPathResolver } from '@cpg/cpg-generator';
import { VsCodeDefinitionResolver } from './resolve/vscodeDefinitionResolver';
import { GraphViewProvider } from './views/graphViewProvider';
import { LogsTreeProvider } from './views/logsTreeProvider';
import { PlaceholderTreeProvider } from './views/placeholderTreeProvider';
import { VsCodeWatchBackend } from './watch/vscodeWatchBackend';
import { WorkspaceSession } from './workspaceSession';

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('cpg-me-daddy');
	context.subscriptions.push(output);

	const logs = new LogsTreeProvider();

	const log = (message: string) => {
		output.appendLine(message);
		logs.log(message);
	};
	
	const graphView = new GraphViewProvider(context.extensionUri, log);
	
	log('CPG-Me-Daddy activated');
	// output.show(true);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('cpgMeDaddy.graph', graphView),
		vscode.window.registerTreeDataProvider('cpgMeDaddy.insights', logs),
		vscode.window.registerTreeDataProvider('cpgMeDaddy.config', new PlaceholderTreeProvider('Config'))
	);

	// Single-root for now — multi-root merging into one graph is a later
	// increment (dropped, along with this branch's raw per-folder logging,
	// when the watcher moved onto WorkspaceSession — see the project plan).
	const [firstFolder] = vscode.workspace.workspaceFolders ?? [];
	if (firstFolder) {
		// The single construction site that decides how references resolve.
		//
		// `VsCodeDefinitionResolver` goes first: it's more precise wherever the
		// language server is configured correctly, and `ChainResolver` keeps the
		// first real *answer* per site — `unresolved`/`dynamic` still fall
		// through — so `PythonPathResolver` behind it keeps answering for the
		// workspaces a type checker can't resolve imports in at all (a flat
		// `src/` layout with no `extraPaths`), and keeps classifying builtins the
		// vscode link deliberately declines to finalize (see that resolver's
		// `no-definition` fallback for out-of-workspace definitions).
		const resolver = new ChainResolver([new VsCodeDefinitionResolver(log), new PythonPathResolver()]);
		log(`resolver: ${resolver.id}`);

		const session = new WorkspaceSession(
			firstFolder.uri.fsPath,
			new VsCodeWatchBackend(),
			(delta) => {
				log(`graph delta for ${firstFolder.name}: +${delta.addedNodes.length}/-${delta.removedNodeIds.length} nodes`);
				graphView.postDelta(delta);
			},
			(error) => {
				log(`file watcher error on ${firstFolder.uri.fsPath}: ${error.message}`);
			},
			log,
			resolver
		);
		context.subscriptions.push({ dispose: () => session.dispose() });

		// ParseWorkspace first, then MonitorWorkspace — session.start() awaits
		// the parse before starting the watcher; see WorkspaceSession.
		session
			.start()
			.then((payload) => graphView.postGraph(payload))
			.catch((error) => {
				log(`failed to index ${firstFolder.name}: ${error instanceof Error ? error.message : String(error)}`);
			});
	}
}

export function deactivate() {}
