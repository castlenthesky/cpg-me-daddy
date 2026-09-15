import { relative } from 'node:path';
import { monitorWorkspace, parseWorkspace, UpdateQueue, type FileWatcherErrorListener, type GraphDeltaListener, type WatchBackend, type WatchSubscription } from '@cpg/file-watcher';
// Type-only, deep import — same rule GraphViewProvider follows (see that
// file and packages/graph-visualizer/AGENTS.md "Gotchas"): the CommonJS
// extension host can't resolve the DOM-typed barrel.
import type { GraphPayload } from '@cpg/graph-visualizer/dist/contract';

/**
 * Owns the ParseWorkspace → MonitorWorkspace phase ordering for one
 * workspace folder — see the project plan ("ParseWorkspace /
 * MonitorWorkspace — the eventual structure"). `REAL`: `start()` runs the
 * two phases back to back, which matches today's behavior exactly, because
 * `parseWorkspace`'s body is still synchronous underneath — there is no gap
 * for a `MonitorWorkspace` event to arrive in before the parse completes.
 *
 * The `UpdateQueue` (`PASSTHROUGH`, see `queue.ts`) is wired in now so that
 * making the parse genuinely async later — and needing to buffer monitor
 * events that arrive mid-parse (migration 4) — is a `pause()`/`resume()`
 * addition around the `parseWorkspace` call below, not a restructuring of
 * this class or its callers.
 */
export class WorkspaceSession {
	private subscription?: WatchSubscription;
	private readonly queue: UpdateQueue;

	constructor(
		private readonly rootPath: string,
		private readonly backend: WatchBackend,
		onDelta: GraphDeltaListener,
		private readonly onError: FileWatcherErrorListener,
		private readonly log: (message: string) => void
	) {
		this.queue = new UpdateQueue(onDelta);
	}

	/** Runs ParseWorkspace, then starts MonitorWorkspace. Resolves with the initial full snapshot. */
	async start(): Promise<GraphPayload> {
		const result = await parseWorkspace(this.rootPath);
		this.log(`indexed ${this.rootPath} (${result.nodeCount} nodes)`);

		this.subscription = monitorWorkspace(
			this.rootPath,
			result.index,
			this.backend,
			(delta) => this.queue.enqueue(delta),
			this.onError,
			(filePath, outputPath) => this.log(`ast dump: ${relative(this.rootPath, filePath)} -> ${relative(this.rootPath, outputPath)}`),
			(change) => {
				const path =
					change.kind === 'moved' && change.fromPath
						? `${relative(this.rootPath, change.fromPath)} -> ${relative(this.rootPath, change.path)}`
						: relative(this.rootPath, change.path);
				this.log(`ast trigger: ${change.kind} ${path}`);
			}
		);

		return result.payload;
	}

	dispose(): void {
		this.subscription?.close();
	}
}
