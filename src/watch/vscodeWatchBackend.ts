import * as vscode from 'vscode';
import type { WatchBackend, WatchSubscription, WorkspaceChange } from '@cpg/file-watcher';

/**
 * The only file in the extension host that knows a `vscode` watcher API
 * exists — see the project plan ("ParseWorkspace / MonitorWorkspace — the
 * eventual structure", migration 2). Everything downstream of
 * `WorkspaceChange[]` (`monitorWorkspace`, `WorkspaceGraphIndex`, the queue)
 * has no `vscode` import at all.
 *
 * `REAL` for create/delete: `createFileSystemWatcher` mapped straight to
 * `'created'`/`'deleted'`. This is what fixes migration 1's two concrete
 * problems — no renames and an unreliable recursive watch on Linux — for
 * the create/delete case; VS Code's native watcher also respects
 * `files.watcherExclude`, which the old `fs.watch` path never did.
 *
 * `onDidChange` is wired and genuinely emits `'changed'` — but `monitor.ts`
 * drops that kind today (a `SEAT`: there's no content pipeline yet to hand
 * it to).
 *
 * `onDidRenameFiles` is wired too, so a rename is visible today — but it's
 * "inert" in the sense the project plan describes: `WorkspaceGraphIndex.
 * applyMove` (also a `SEAT`) falls back to delete+create rather than
 * preserving the node's position, so a rename currently looks like churn in
 * the graph, not a move. Migration 5 is what fixes the rendering; nothing
 * here needs to change when it does. And per the plan's migration 1
 * caveat — confirmed in this repo's own `research/R1-file-change-
 * detection.md` — `onDidRenameFiles` only fires for renames done *through*
 * VS Code (Explorer rename, a refactor); a terminal `mv` or `git mv` still
 * arrives as the delete+create above, which is already handled correctly.
 */
export class VsCodeWatchBackend implements WatchBackend {
	subscribe(
		rootPath: string,
		onChange: (changes: WorkspaceChange[]) => void,
		onError?: (error: Error) => void
	): WatchSubscription {
		// vscode.FileSystemWatcher has no synchronous failure mode and no
		// 'error' event to report through onError — unlike the old fs.watch
		// path, there's nothing to wire it to yet.
		void onError;

		const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === rootPath);
		const pattern = folder ? new vscode.RelativePattern(folder, '**/*') : new vscode.RelativePattern(vscode.Uri.file(rootPath), '**/*');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);

		const disposables: vscode.Disposable[] = [
			watcher,
			watcher.onDidCreate((uri) => onChange([{ kind: 'created', path: uri.fsPath }])),
			watcher.onDidDelete((uri) => onChange([{ kind: 'deleted', path: uri.fsPath }])),
			watcher.onDidChange((uri) => onChange([{ kind: 'changed', path: uri.fsPath }])),
			vscode.workspace.onDidRenameFiles((event) => {
				const moves: WorkspaceChange[] = event.files
					.filter((file) => isUnderRoot(file.oldUri.fsPath, rootPath))
					.map((file) => ({ kind: 'moved', path: file.newUri.fsPath, fromPath: file.oldUri.fsPath }));
				if (moves.length > 0) {
					onChange(moves);
				}
			}),
		];

		return { close: () => disposables.forEach((d) => d.dispose()) };
	}
}

function isUnderRoot(path: string, rootPath: string): boolean {
	return path === rootPath || path.startsWith(rootPath + '/') || path.startsWith(rootPath + '\\');
}
