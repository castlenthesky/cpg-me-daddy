// Zero imports, deliberately — same rule as @cpg/graph-visualizer's
// contract.ts (see that package's AGENTS.md "Gotchas"). This is the
// migration-2 seam from the project plan ("ParseWorkspace / MonitorWorkspace
// — the eventual structure"): everything downstream of `WorkspaceChange[]`
// depends only on these types, never on a concrete watcher, so the hard
// logic (how a burst of changes updates the index) can be driven by a fake
// `WatchBackend` in a test with no filesystem watching and no VS Code at all.

/**
 * The watcher's own vocabulary, independent of whichever backend produced
 * it. `'moved'` is reported only by a backend that can tell (today: VS
 * Code's `onDidRenameFiles`, and only for renames done through VS Code
 * itself — see `src/watch/vscodeWatchBackend.ts` in the extension host for
 * the caveat). A backend that can't distinguish a move reports it as
 * `'deleted'` + `'created'` instead, which is exactly what a plain
 * create/delete watcher (Node's `fs.watch`, a terminal `mv`) looks like.
 */
export type ChangeKind = 'created' | 'changed' | 'deleted' | 'moved';

export interface WorkspaceChange {
	kind: ChangeKind;
	/** Absolute filesystem path — the destination path for a `'moved'` change. */
	path: string;
	/** Only set for `kind: 'moved'` — the path before the move. */
	fromPath?: string;
}

export interface WatchSubscription {
	close(): void;
}

/**
 * The MonitorWorkspace phase's backend seam. `monitorWorkspace` (see
 * `monitor.ts`) depends only on this, never on a concrete watcher API — the
 * extension host's `VsCodeWatchBackend` (`src/watch/vscodeWatchBackend.ts`)
 * is the only implementation today, but a future headless implementation (a
 * `cpg` CLI, if one comes back — see the deleted `packages/engine`) is a new
 * implementation of this interface, not a rewrite of everything downstream.
 */
export interface WatchBackend {
	subscribe(
		rootPath: string,
		onChange: (changes: WorkspaceChange[]) => void,
		onError?: (error: Error) => void
	): WatchSubscription;
}
