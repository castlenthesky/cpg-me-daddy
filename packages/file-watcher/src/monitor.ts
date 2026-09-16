import { join, relative } from 'node:path';
import type { Resolver } from '@cpg/cpg-generator';
import type { GraphBuilder } from '@cpg/graph-builder';
// Type-only, deep import — see the note at the top of index.ts.
import type { GraphDelta } from '@cpg/graph-visualizer/dist/contract';
import { AstPipeline } from './astPipeline';
import type { WatchBackend, WatchSubscription, WorkspaceChange } from './changes';
import { ChangeBatcher } from './debounce';
import { createIgnoreFilter, type WorkspaceGraphIndex } from './index';

export type GraphDeltaListener = (delta: GraphDelta) => void;
export type FileWatcherErrorListener = (error: Error) => void;
/** Fired after a created/changed/moved file's AST lands on disk — `outputPath` is where. */
export type AstDumpListener = (filePath: string, outputPath: string) => void;
/**
 * Fired for *every* `WorkspaceChange` `applyOne` handles — addition,
 * deletion, rename/move, content edit — before it decides whether an AST
 * dump actually happens. This is a trace signal, not a "dump happened"
 * signal: `'deleted'` always fires this and never `onAstDump` (there's no
 * content left to parse), and an unsupported extension fires this but not
 * `onAstDump` either. Use `onAstDump` for "a file's AST was written."
 */
export type AstTriggerListener = (change: WorkspaceChange) => void;

export interface MonitorOptions {
	onDelta?: GraphDeltaListener;
	onError?: FileWatcherErrorListener;
	onAstDump?: AstDumpListener;
	onAstTrigger?: AstTriggerListener;
	/**
	 * Owns the AST-derived node ids currently on screen per file (see `@cpg/graph-builder`) — the
	 * CPG pipeline SEAT below only runs when this is supplied. Passed in rather than constructed
	 * here so it's the caller's to own and, eventually, inject a fake of in a test.
	 */
	builder?: GraphBuilder;
	/**
	 * Re-resolves a saved file's own references, so its cross-file edges survive
	 * the save. Must be the *same instance* ParseWorkspace used — see
	 * `AstPipelineOptions.resolver` for why only the saved file needs it.
	 */
	resolver?: Resolver;
	/** Where the AST pipeline writes its debug JSON dump. Defaults to `<rootPath>/out/ast`. */
	astOutputDir?: string;
	/** Whether the AST pipeline writes its debug JSON dump at all. Defaults to `true`. */
	dumpAstToDisk?: boolean;
}

/**
 * The MonitorWorkspace phase's routing layer — see the project plan
 * ("ParseWorkspace / MonitorWorkspace — the eventual structure", migration
 * 2). Normalizes whatever `backend` reports into `WorkspaceGraphIndex`
 * mutations and `GraphDelta`s, with no idea which concrete watcher produced
 * the events — everything below `WatchBackend` in the project plan's
 * diagram is backend-agnostic, which is what lets this be driven by a fake
 * backend in a test with no VS Code involved at all.
 *
 * Batches rapid-fire changes through `ChangeBatcher` (100ms trailing /
 * 500ms ceiling, deduped by path) before applying them, so several events
 * for one editor save collapse into one pass over the index rather than one
 * rescan per event — the same role `WorkspaceGraphIndex.applyChange`'s
 * disk-diffing already plays for *what* a rescan finds, applied here to
 * *how often* a rescan runs.
 */
export function monitorWorkspace(rootPath: string, index: WorkspaceGraphIndex, backend: WatchBackend, options: MonitorOptions = {}): WatchSubscription {
	const { onDelta, onError, onAstDump, onAstTrigger, builder, resolver, dumpAstToDisk = true } = options;
	const isIgnored = createIgnoreFilter(rootPath);
	const pipeline = builder
		? new AstPipeline({
				builder,
				astOutputDir: options.astOutputDir ?? join(rootPath, 'out', 'ast'),
				dumpAstToDisk,
				workspaceRoot: rootPath,
				resolver,
				onDelta,
				onError,
				onAstDump,
			})
		: undefined;

	const batcher = new ChangeBatcher<WorkspaceChange>((changes) => {
		for (const change of changes) {
			onAstTrigger?.(change);
			const delta = applyOne(index, change, builder);
			if (delta) {
				onDelta?.(delta);
			}
			if ((change.kind === 'created' || change.kind === 'changed' || change.kind === 'moved') && pipeline) {
				pipeline.run(change.path);
			}
		}
	});

	const subscription = backend.subscribe(
		rootPath,
		(changes) => {
			for (const change of changes) {
				if (!isIgnored(relative(rootPath, change.path))) {
					batcher.add(change.path, change);
				}
			}
		},
		onError
	);

	return {
		close: () => {
			batcher.dispose();
			subscription.close();
		},
	};
}

/**
 * The synchronous presence half of a change: whether a file/directory node needs to appear,
 * disappear, or move. The AST half (parse -> flatten -> `GraphBuilder.replaceFile`) is async and
 * handled separately by `AstPipeline`, dispatched from `monitorWorkspace` above — a wasm parse is far
 * too slow to hold up this pass.
 */
function applyOne(index: WorkspaceGraphIndex, change: WorkspaceChange, builder: GraphBuilder | undefined): GraphDelta | undefined {
	switch (change.kind) {
		case 'created':
			return index.applyChange(change.path);
		case 'deleted':
			return withAstRemovals(index.applyChange(change.path), builder);
		case 'moved':
			return withAstRemovals(index.applyMove(change.fromPath ?? change.path, change.path), builder);
		case 'changed':
			// Presence can't change from a content edit alone — the file/directory node this
			// change touches already exists. Its AST, if any, is handled by AstPipeline.
			return undefined;
	}
}

/**
 * A presence delta's `removedNodeIds` names only the file/directory node(s) that disappeared, never
 * the AST ids hanging off them — `@cpg/graph-visualizer` only tombstones ids explicitly listed, so
 * without this, a deleted file's (or an entire deleted directory's descendants') AST subtree would
 * linger on screen as an orphan once its file node is gone. `builder.removeUnder` sweeps every
 * tracked file under a removed id (covering a whole-directory delete/move, not just a single file)
 * and returns their AST ids to fold in here.
 */
function withAstRemovals(delta: GraphDelta | undefined, builder: GraphBuilder | undefined): GraphDelta | undefined {
	if (!delta || !builder) {
		return delta;
	}
	const astRemovals = builder.removeUnder(delta.removedNodeIds);
	if (astRemovals.length === 0) {
		return delta;
	}
	return { ...delta, removedNodeIds: [...delta.removedNodeIds, ...astRemovals] };
}
