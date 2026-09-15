import { join, relative } from 'node:path';
import { dumpAst, isSupportedExtension } from '@cpg/ast-generator';
// Type-only, deep import — see the note at the top of index.ts.
import type { GraphDelta } from '@cpg/graph-visualizer/dist/contract';
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
export function monitorWorkspace(
	rootPath: string,
	index: WorkspaceGraphIndex,
	backend: WatchBackend,
	onDelta?: GraphDeltaListener,
	onError?: FileWatcherErrorListener,
	onAstDump?: AstDumpListener,
	onAstTrigger?: AstTriggerListener
): WatchSubscription {
	const isIgnored = createIgnoreFilter(rootPath);

	const batcher = new ChangeBatcher<WorkspaceChange>((changes) => {
		for (const change of changes) {
			onAstTrigger?.(change);
			const delta = applyOne(rootPath, index, change, onAstDump, onError);
			if (delta) {
				onDelta?.(delta);
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

function applyOne(
	rootPath: string,
	index: WorkspaceGraphIndex,
	change: WorkspaceChange,
	onAstDump?: AstDumpListener,
	onError?: FileWatcherErrorListener
): GraphDelta | undefined {
	switch (change.kind) {
		case 'created':
			maybeDumpAst(rootPath, change.path, onAstDump, onError);
			return index.applyChange(change.path);
		case 'deleted':
			// No content left to parse — nothing for the AST step to do. A stale
			// out/ast/ dump for a deleted file is left behind today; cleaning it
			// up is future work, not covered by onAstTrigger/onAstDump.
			return index.applyChange(change.path);
		case 'moved':
			// The file has real content at its new path — re-parse there so a
			// rename/move produces a fresh AST dump under its new name, not a
			// stale one under the old.
			maybeDumpAst(rootPath, change.path, onAstDump, onError);
			return index.applyMove(change.fromPath ?? change.path, change.path);
		case 'changed':
			// REAL (partial) — the first leg of the CPG pipeline SEAT:
			//   ast-generator.parse(path) -> cpg-generator.toSubgraph(ast) ->
			//   graph-builder.replaceFile(path, subgraph) -> a GraphDelta.
			// maybeDumpAst below now does the ast-generator leg for real. Still no
			// GraphDelta from a content edit: presence can't change, and
			// cpg-generator/graph-builder — the rest of the pipeline that would
			// turn an AST into a graph update — are still hello() stubs with
			// nothing to call.
			maybeDumpAst(rootPath, change.path, onAstDump, onError);
			return undefined;
	}
}

/**
 * Fire-and-forget: parses `filePath` and writes its AST JSON under
 * `<rootPath>/out/ast/` (the workspace's own `out/`, not this extension's —
 * see `@cpg/ast-generator`'s `dumpAst`). Not awaited by `applyOne` — a wasm
 * parse is too slow to block every batch flush on, and nothing downstream
 * yet consumes the result synchronously (no `cpg-generator` to hand it to).
 * Extensions `@cpg/ast-generator` has no grammar for (most of a workspace)
 * are skipped rather than logged as errors; a real failure — a corrupt file,
 * a wasm load problem — still reaches `onError`.
 */
function maybeDumpAst(rootPath: string, filePath: string, onAstDump: AstDumpListener | undefined, onError: FileWatcherErrorListener | undefined): void {
	if (!isSupportedExtension(filePath)) {
		return;
	}
	dumpAst(filePath, join(rootPath, 'out', 'ast'))
		.then((outputPath) => onAstDump?.(filePath, outputPath))
		.catch((error: unknown) => {
			onError?.(error instanceof Error ? error : new Error(String(error)));
		});
}
