import { relative } from 'node:path';
import { GraphBuilder } from '@cpg/graph-builder';
import { monitorWorkspace, parseWorkspace, UpdateQueue, type FileWatcherErrorListener, type GraphDeltaListener, type WatchBackend, type WatchSubscription } from '@cpg/file-watcher';
import type { Resolver } from '@cpg/cpg-generator';
// Type-only, deep import — same rule GraphViewProvider follows (see that
// file and packages/graph-visualizer/AGENTS.md "Gotchas"): the CommonJS
// extension host can't resolve the DOM-typed barrel.
import type { GraphPayload } from '@cpg/graph-visualizer/dist/contract';

/** How often ParseWorkspace's per-file progress reaches the log — see `start()`. */
const PARSE_LOG_INTERVAL = 25;

/**
 * Owns the ParseWorkspace → MonitorWorkspace phase ordering for one
 * workspace folder — see the project plan ("ParseWorkspace /
 * MonitorWorkspace — the eventual structure"). `start()` runs the two phases
 * back to back.
 *
 * The parse is now genuinely async (it parses every supported file), so it
 * spans real time — but it still can't race the monitor, because the watcher
 * isn't subscribed until after it resolves. What that does open is a blind
 * window: the directory walk snapshots the workspace before the AST pass
 * begins, and edits made between that snapshot and `monitorWorkspace`'s
 * subscription below are seen by neither phase. Closing it means subscribing
 * first and buffering — which is what the `UpdateQueue` (`PASSTHROUGH`, see
 * `queue.ts`) is already wired in for: a `pause()`/`resume()` pair around the
 * parse (migration 4), not a restructuring of this class or its callers.
 */
export class WorkspaceSession {
	private subscription?: WatchSubscription;
	private readonly queue: UpdateQueue;
	private readonly graphBuilder = new GraphBuilder();

	constructor(
		private readonly rootPath: string,
		private readonly backend: WatchBackend,
		onDelta: GraphDeltaListener,
		private readonly onError: FileWatcherErrorListener,
		private readonly log: (message: string) => void,
		// One resolver instance for the whole session, for the same reason
		// there's one `graphBuilder`: the precise implementation caches (an
		// opened text document, a warmed language server), and a second
		// instance would be free today — `NullResolver` is stateless — and
		// wrong the moment it isn't.
		private readonly resolver: Resolver
	) {
		this.queue = new UpdateQueue(onDelta);
	}

	/** Runs ParseWorkspace, then starts MonitorWorkspace. Resolves with the initial full snapshot. */
	async start(): Promise<GraphPayload> {
		// The same `graphBuilder` goes to both phases — ParseWorkspace records
		// which AST ids each file contributed, MonitorWorkspace replaces or
		// removes exactly those on a later save or delete. Two instances here
		// would leave every file's activation-time AST on screen forever, as a
		// duplicate under its re-parsed self.
		// The resolver is handed a *lookup*, never the graph — `GraphBuilder`
		// satisfies `DefinitionLookup` structurally, so @cpg/graph-builder still
		// imports nothing but the render contract.
		await this.resolver.open({ rootPath: this.rootPath, definitions: this.graphBuilder });

		const result = await parseWorkspace(this.rootPath, {
			builder: this.graphBuilder,
			resolver: this.resolver,
			onResolveError: (filePath, error) => this.log(`resolve failed: ${relative(this.rootPath, filePath)}: ${error.message}`),
			onProgress: (parsed, total, filePath) => {
				// Only every PARSE_LOG_INTERVAL files, plus the last: the Insights
				// panel keeps a capped rolling log, and a line per file would
				// push everything else out of it on any real workspace.
				if (parsed % PARSE_LOG_INTERVAL === 0 || parsed === total) {
					this.log(`parsing ${parsed}/${total}: ${relative(this.rootPath, filePath)}`);
				}
			},
			onAstError: (filePath, error) => this.log(`ast parse failed: ${relative(this.rootPath, filePath)}: ${error.message}`),
		});
		const ast = result.ast;
		this.log(
			`indexed ${this.rootPath} (${result.nodeCount} nodes` +
				(ast ? `, ${ast.nodes.length} from ${ast.parsedFileCount}/${ast.supportedFileCount} parsed files${ast.truncated ? ', truncated' : ''}` : '') +
				')'
		);
		const resolution = result.resolution;
		if (resolution) {
			// The unresolved count is the number worth watching: it's the
			// honest measure of how much of the call graph is actually linked,
			// and `external` is broken out because a builtin resolving to
			// nothing is expected rather than a gap.
			const unresolved = resolution.referenceSiteCount - resolution.resolvedCount - resolution.externalCount;
			this.log(
				`resolved ${resolution.resolvedCount}/${resolution.referenceSiteCount} references in ${resolution.fileCount} files ` +
					`(${resolution.externalCount} external, ${unresolved} unresolved) -> ${resolution.edges.length} cross-reference edges`
			);
		}

		this.subscription = monitorWorkspace(this.rootPath, result.index, this.backend, {
			onDelta: (delta) => this.queue.enqueue(delta),
			onError: this.onError,
			builder: this.graphBuilder,
			// Same instance ParseWorkspace used: a saved file's own references
			// have to be re-resolved (its CALL/IMPORT ids are re-minted, so
			// their old edges are dropped), and a second resolver instance
			// would have to re-read its configuration to answer.
			resolver: this.resolver,
			onAstDump: (filePath, outputPath) => this.log(`ast dump: ${relative(this.rootPath, filePath)} -> ${relative(this.rootPath, outputPath)}`),
			onAstTrigger: (change) => {
				const path =
					change.kind === 'moved' && change.fromPath
						? `${relative(this.rootPath, change.fromPath)} -> ${relative(this.rootPath, change.path)}`
						: relative(this.rootPath, change.path);
				this.log(`ast trigger: ${change.kind} ${path}`);
			},
		});

		return result.payload;
	}

	dispose(): void {
		this.subscription?.close();
	}
}
