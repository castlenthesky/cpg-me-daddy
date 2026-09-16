import { isSupportedExtension, parseFile } from '@cpg/ast-generator';
import { toSubgraph } from '@cpg/cpg-generator';
import type { GraphBuilder } from '@cpg/graph-builder';
// Type-only, deep import — see the note at the top of index.ts.
import type { GraphEdge, GraphNode } from '@cpg/graph-visualizer/dist/contract';
import type { FileTreeNode, ParseWorkspaceToken } from './index';

/**
 * Fired once per parsed file. `parsed` counts files finished (including ones
 * that failed), `total` is how many supported files the pass found up front.
 */
export type AstPassProgressListener = (parsed: number, total: number, currentFilePath: string) => void;
/** Fired for one file that couldn't be parsed; the pass continues with the rest. */
export type AstPassErrorListener = (filePath: string, error: Error) => void;

export interface AstPassOptions {
	/**
	 * Registers each file's emitted ids so a later re-parse (`replaceFile`) or
	 * deletion (`removeUnder`) can remove exactly what ParseWorkspace put on
	 * screen. Must be the same `GraphBuilder` instance later handed to
	 * `monitorWorkspace`, or the MonitorWorkspace phase will believe every
	 * file's first save is its first parse and leave the ParseWorkspace-era
	 * nodes behind as duplicates.
	 */
	builder?: GraphBuilder;
	/** Turns symbol minting on — an fqn is keyed on the workspace-relative path, so `toSubgraph` can't mint one without knowing the root. See `ToSubgraphOptions.workspaceRoot`. */
	workspaceRoot?: string;
	/** Workspace-wide ceiling on emitted AST nodes — see `DEFAULT_MAX_AST_NODES`. */
	maxNodes?: number;
	onProgress?: AstPassProgressListener;
	onError?: AstPassErrorListener;
	token?: ParseWorkspaceToken;
}

export interface AstPassResult {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** Files successfully parsed and flattened (excludes skipped and failed ones). */
	parsedFileCount: number;
	/** Supported files the pass set out to parse. */
	supportedFileCount: number;
	/** True when `maxNodes`, or a cancelled `token`, stopped the pass before every supported file was parsed. */
	truncated: boolean;
}

/**
 * Workspace-wide ceiling, distinct from `toSubgraph`'s own per-file
 * `maxNodes`: that one stops a single huge file from swamping the view, this
 * one stops a huge *workspace* from doing the same with thousands of ordinary
 * files. Both are blunt instruments — the eventual answer is level-of-detail
 * rendering (expand a file's AST on demand rather than drawing all of them at
 * once), at which point this cap goes away.
 */
export const DEFAULT_MAX_AST_NODES = 20_000;

// The event loop gets a turn every this many files, so a long parse can't wedge
// the extension host — `parseFile` awaits I/O, but the tree-sitter parse and the
// `toSubgraph` walk between those awaits are synchronous CPU work.
const YIELD_EVERY_FILES = 10;

/** Depth-first, so files land in the same order `walkWorkspace` produced them. */
function collectSupportedFiles(node: FileTreeNode, into: string[]): string[] {
	if (node.type === 'file') {
		if (isSupportedExtension(node.path)) {
			into.push(node.path);
		}
		return into;
	}
	for (const child of node.children ?? []) {
		collectSupportedFiles(child, into);
	}
	return into;
}

/**
 * The AST half of the ParseWorkspace phase: parses every supported file in an
 * already-walked tree and flattens each one into the same
 * `{ nodes, edges }` shape `toGraphPayload` produces for files and
 * directories, ready to concatenate onto it.
 *
 * This is the one-shot counterpart to `AstPipeline` (`astPipeline.ts`), which
 * does the same three steps for a *single* file on a watcher event. They stay
 * separate because they answer to different pressures: `AstPipeline` is
 * fire-and-forget, serialized per path, and emits a `GraphDelta` per file as
 * it resolves, while this one runs to completion before anything renders and
 * returns one merged result. What they must agree on is the `GraphBuilder`
 * instance — see `AstPassOptions.builder`.
 *
 * A file that fails to parse is reported to `onError` and skipped; one corrupt
 * file in a workspace must not cost the user the whole graph.
 */
export async function runAstPass(tree: FileTreeNode, options: AstPassOptions = {}): Promise<AstPassResult> {
	const { builder, workspaceRoot, maxNodes = DEFAULT_MAX_AST_NODES, onProgress, onError, token } = options;

	const filePaths = collectSupportedFiles(tree, []);
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	let parsedFileCount = 0;
	let truncated = false;

	for (const [i, filePath] of filePaths.entries()) {
		if (token?.isCancellationRequested) {
			truncated = true;
			break;
		}
		if (nodes.length >= maxNodes) {
			truncated = true;
			break;
		}

		try {
			const subgraph = toSubgraph(await parseFile(filePath), { workspaceRoot });
			// Registered even when empty (an unsupported grammar, or a file with no
			// significant constructs): `replaceFile` records the id list this file
			// currently owns, and "none" is the honest answer for it.
			// The returned delta's `addedNodes` carries the symbols this file
			// defines, which `subgraph.nodes` deliberately does not — symbols are
			// reference-counted by the builder, not owned by the file.
			const delta = builder?.replaceFile(filePath, subgraph);
			nodes.push(...(delta ? delta.addedNodes : subgraph.nodes));
			edges.push(...subgraph.edges);
			parsedFileCount++;
		} catch (error: unknown) {
			onError?.(filePath, error instanceof Error ? error : new Error(String(error)));
		}

		onProgress?.(i + 1, filePaths.length, filePath);
		if ((i + 1) % YIELD_EVERY_FILES === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	return { nodes, edges, parsedFileCount, supportedFileCount: filePaths.length, truncated };
}
