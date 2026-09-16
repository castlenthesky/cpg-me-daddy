import { isSupportedExtension, parseFile, writeAstJson } from '@cpg/ast-generator';
import { toSubgraph, type Resolver } from '@cpg/cpg-generator';
import type { GraphBuilder } from '@cpg/graph-builder';
import type { AstDumpListener, FileWatcherErrorListener, GraphDeltaListener } from './monitor';
import { runResolvePass } from './resolvePass';

export interface AstPipelineOptions {
	builder: GraphBuilder;
	astOutputDir: string;
	dumpAstToDisk: boolean;
	/** Turns symbol minting on for the save path — must match what ParseWorkspace used, or a saved file's symbols get different ids than its activation-time ones. */
	workspaceRoot?: string;
	/**
	 * Re-resolves the saved file's own references.
	 *
	 * Not optional in spirit: `replaceFile` re-mints the file's `CALL`/`IMPORT`
	 * ids, so `applyGraphDelta` drops their old edges as collateral. Without
	 * re-resolving, a file's cross-file edges would disappear on its first save
	 * and not come back until the workspace was re-opened.
	 *
	 * Only the saved file is re-resolved. References in *other* files pointing
	 * into this one need nothing, which is the whole payoff of routing through
	 * symbols: their edges name an fqn, and an fqn doesn't change when this file
	 * is re-parsed.
	 */
	resolver?: Resolver;
	onDelta?: GraphDeltaListener;
	onError?: FileWatcherErrorListener;
	onAstDump?: AstDumpListener;
}

/**
 * The async half of the CPG pipeline SEAT named in `monitor.ts`:
 *   ast-generator.parse(path) -> cpg-generator.toSubgraph(ast) -> graph-builder.replaceFile(path, subgraph) -> a GraphDelta.
 *
 * Runs beside `applyOne`'s synchronous presence delta rather than blocking on it — a wasm parse is
 * too slow to hold up every batch flush. `onDelta` fires again, independently, once the parse and
 * flatten resolve; the presence delta (which puts the file's own node on screen) has already gone
 * out synchronously by the time this could possibly resolve, so an AST subtree can never arrive
 * before the file node it hangs off of.
 *
 * `run(filePath)` is queued behind any run already in flight for that same path (see `tailByPath`):
 * two saves close enough together can put two parses in flight, and without ordering the slower one
 * can resolve last and clobber the newer result with a stale one.
 */
export class AstPipeline {
	private readonly tailByPath = new Map<string, Promise<void>>();

	constructor(private readonly options: AstPipelineOptions) {}

	/** Fire-and-forget. Extensions with no registered grammar are skipped silently; a real failure (a corrupt file, a wasm load problem) reaches `onError`. */
	run(filePath: string): void {
		if (!isSupportedExtension(filePath)) {
			return;
		}
		const previous = this.tailByPath.get(filePath) ?? Promise.resolve();
		const next = previous.then(() => this.runOnce(filePath)).catch((error: unknown) => {
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
		this.tailByPath.set(filePath, next);
	}

	private async runOnce(filePath: string): Promise<void> {
		const parsed = await parseFile(filePath);
		if (this.options.dumpAstToDisk) {
			const outputPath = await writeAstJson(parsed, this.options.astOutputDir);
			this.options.onAstDump?.(filePath, outputPath);
		}
		const subgraph = toSubgraph(parsed, { workspaceRoot: this.options.workspaceRoot });
		const delta = this.options.builder.replaceFile(filePath, subgraph);

		// Re-resolve before emitting, so the file's nodes and their cross-file
		// edges arrive in one delta. Splitting them would briefly render the
		// file with its edges missing, and `applyDeltaInternal` seeds positions
		// from parents present in the same delta.
		if (this.options.resolver) {
			const resolution = await runResolvePass(delta.addedNodes, {
				resolver: this.options.resolver,
				definitions: this.options.builder,
				onError: (path, error) => this.options.onError?.(new Error(`resolve failed for ${path}: ${error.message}`)),
			});
			delta.addedEdges.push(...resolution.edges);
		}

		this.options.onDelta?.(delta);
	}
}
