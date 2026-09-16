import { collectReferenceSites, type DefinitionLookup, type RefKind, type RefSite, type Resolution, type Resolver } from '@cpg/cpg-generator';
// Type-only, deep import — see the note at the top of index.ts.
import type { GraphEdge, GraphNode } from '@cpg/graph-visualizer/dist/contract';
import type { ParseWorkspaceToken } from './index';

/**
 * Edge type per reference kind. `call`/`import` target a `SYMBOL` fqn
 * (`CALLS`/`IMPORTS`); `receiver-type` also targets a `SYMBOL` fqn
 * (`EVAL_TYPE`) and is minted through the exact same `symbolFor`/`hasSymbol`
 * path. `receiver` (`RECEIVER`) is the odd one out: it targets an AST node id
 * in the *same file*, never a symbol — see the dedicated branch in
 * `runResolvePass` for why.
 */
const EDGE_TYPES: Record<RefKind, string> = { call: 'CALLS', import: 'IMPORTS', receiver: 'RECEIVER', 'receiver-type': 'EVAL_TYPE' };

/** Site kinds whose `data.resolution` may be written onto the reference node's tooltip — see `annotate`. `receiver`/`receiver-type` share a `CALL` node's `nodeId` with its `call` site, so writing them there too would let whichever ran last overwrite a cleanly-resolved call's own status. */
const ANNOTATABLE_KINDS: ReadonlySet<RefKind> = new Set(['call', 'import']);

/** Fired once per file whose references have been resolved. */
export type ResolvePassProgressListener = (resolvedFiles: number, totalFiles: number, currentFilePath: string) => void;
/** Fired for one file whose resolution failed; the pass continues with the rest. */
export type ResolvePassErrorListener = (filePath: string, error: Error) => void;

export interface ResolvePassOptions {
	resolver: Resolver;
	/** Maps a definition *location* (all a language server reports) to the symbol defined there. `GraphBuilder` satisfies this structurally. */
	definitions: DefinitionLookup;
	onProgress?: ResolvePassProgressListener;
	onError?: ResolvePassErrorListener;
	token?: ParseWorkspaceToken;
}

export interface ResolvePassResult {
	/** Always empty: the symbols already exist, emitted by whichever file *defines* them. This pass only adds edges into them. */
	nodes: GraphNode[];
	/** `CALLS`/`IMPORTS`/`RECEIVER`/`EVAL_TYPE` edges, deduplicated. */
	edges: GraphEdge[];
	/** `call`/`import` sites found — non-zero from the moment this pass is wired, which is what proves it is running. */
	referenceSiteCount: number;
	/** `call`/`import` sites that produced an edge into a symbol. */
	resolvedCount: number;
	/** Sites resolved to something outside the graph — a builtin or a third-party package. Deliberately edge-less; see the note on `EDGE_TYPES`. */
	externalCount: number;
	/** Files that contained at least one reference site. */
	fileCount: number;
	/**
	 * `receiver`/`receiver-type` sites found, counted separately from
	 * `referenceSiteCount`: a receiver bound by a function parameter (no
	 * `LOCAL` node to point at — see `subgraph.ts`'s significance table) can
	 * never resolve, and folding it into the same denominator would make the
	 * headline resolved/total ratio incomparable across a slice that adds
	 * receiver handling to one that doesn't.
	 */
	receiverSiteCount: number;
	/** Of `receiverSiteCount`, how many produced a `RECEIVER` or `EVAL_TYPE` edge. */
	receiverResolvedCount: number;
}

// Matches `astPass.ts`'s YIELD_EVERY_FILES for the same reason: the resolver's
// own work is awaited I/O and yields naturally, but the collect-and-group step
// around it is synchronous, so a large workspace still gets a turn.
const YIELD_EVERY_FILES = 10;

/**
 * REAL — the one place a graph's `CALL`/`IMPORT` nodes are handed to a
 * `Resolver` and the answers become `CALLS`/`IMPORTS` edges into `SYMBOL`
 * nodes.
 *
 * It mints no symbol nodes. Those come from whichever file *defines* the
 * symbol, via `toSubgraph`'s `symbols` channel and `GraphBuilder.replaceFile`,
 * and that division is what makes the lifetime work: a symbol is owned by its
 * definition (reference-counted, so it outlives any one save) while a reference
 * only ever contributes an edge. A reference to something no file in the
 * workspace defines therefore resolves to nothing and simply gets no edge.
 *
 * It runs as a **third pass**, after the AST pass has finished, and that
 * ordering is load-bearing rather than incidental: a call in the first file
 * walked can target a definition in the last, so until every file is parsed the
 * definition index has no entry at the target location. Resolving during the
 * walk would report `unresolved` for a resolvable reference, and *which* ones
 * would depend on walk order — non-determinism is far worse than lateness for
 * something whose output is checked by eye.
 *
 * Grouping by file before calling the resolver is also not cosmetic: the
 * precise implementation opens a text document per file and lets a language
 * server answer from a warm index, so one call per file with N sites is much
 * cheaper than N calls, and it is the granularity a per-file cap can be applied
 * at.
 */
export async function runResolvePass(nodes: readonly GraphNode[], options: ResolvePassOptions): Promise<ResolvePassResult> {
	const { resolver, definitions, onProgress, onError, token } = options;

	const sites = collectReferenceSites(nodes);
	const sitesById = new Map(sites.map((site) => [site.id, site]));
	const nodesById = new Map(nodes.map((node) => [node.id, node]));
	const sitesByFile = groupByFile(sites);
	const referenceSiteCount = sites.filter((site) => ANNOTATABLE_KINDS.has(site.kind)).length;
	const receiverSiteCount = sites.length - referenceSiteCount;
	// The `RECEIVER` edge's target-lookup table: an fqn-less, same-file index
	// from a node's own name-token position to its id, built once from this
	// call's `nodes` (the whole workspace payload, or one save's
	// `delta.addedNodes` — either way it's what the receiver's binding must
	// appear in). `SYMBOL` nodes are excluded on purpose: `toSubgraph` stamps a
	// symbol's `location` byte-identical to its defining `METHOD`/`TYPE_DECL`
	// (both call `locationFor` with the same arguments), and symbols are
	// appended *after* AST nodes by `GraphBuilder.replaceFile`, so without this
	// exclusion the symbol would silently win the position and every
	// `RECEIVER` edge would point at a symbol instead of the binding.
	const nodeByPosition = indexNodesByPosition(nodes);
	// Deduplicated, because several sites legitimately land on one pair: two
	// bindings of one import statement can name the same symbol, and repeated
	// calls in one file are separate CALL nodes but would collide if a file
	// ever emitted two references from the same node to the same target.
	const edgesByKey = new Map<string, GraphEdge>();
	let resolvedCount = 0;
	let externalCount = 0;
	let receiverResolvedCount = 0;
	let processed = 0;

	for (const [filePath, fileSites] of sitesByFile) {
		if (token?.isCancellationRequested) {
			break;
		}
		try {
			const resolutions = await resolver.resolve(filePath, fileSites, token);
			for (const resolution of resolutions) {
				const site = sitesById.get(resolution.refId);

				// Mirrored onto the reference node so an edge-less CALL can
				// explain itself in the tooltip. Only for `call`/`import`:
				// `receiver`/`receiver-type` sites share that node's `nodeId`,
				// and writing them here too would let whichever ran last
				// overwrite a cleanly-resolved call's own status. Written in
				// place rather than as a delta because `GraphDelta` has no
				// node-update operation, and remove-plus-re-add to set one
				// property would cost the node its position. These are the
				// pass's own freshly-built nodes.
				if (site && ANNOTATABLE_KINDS.has(site.kind)) {
					annotate(site.nodeId, nodesById, resolution);
				}

				if (resolution.status === 'external') {
					externalCount++;
					continue;
				}
				if (resolution.status !== 'resolved' && resolution.status !== 'ambiguous') {
					continue;
				}
				if (!site) {
					continue;
				}

				if (site.kind === 'receiver') {
					// Targets an AST node id, never a symbol — and only within
					// the same file. `GraphDelta` has no `removedEdgeIds`, and
					// `AstPipeline` re-resolves only the *saved* file, so a
					// cross-file AST-node edge would be swept the moment the
					// *target* file is next saved and never rebuilt. `EVAL_TYPE`
					// is the cross-file answer for a receiver; this is the
					// same-file one.
					const definition = resolution.definition;
					if (!definition || definition.filePath !== site.filePath) {
						continue;
					}
					const targetId = nodeByPosition.get(definition.filePath)?.get(positionKey(definition.position.row, definition.position.column));
					if (!targetId) {
						continue;
					}
					if (resolution.status === 'resolved') {
						receiverResolvedCount++;
					}
					addEdge(edgesByKey, site.nodeId, targetId, EDGE_TYPES.receiver, resolution);
					continue;
				}

				const fqn = symbolFor(resolution, definitions);
				// No symbol node means nothing to point at. Happens for a
				// definition in a file we never parsed, or one the per-file node
				// cap truncated away. Asked of the builder rather than derived
				// from `nodes`, because a per-save re-resolve sees only one
				// file's nodes yet must link into symbols other files define.
				if (!fqn || !definitions.hasSymbol(fqn)) {
					continue;
				}
				if (site.kind === 'receiver-type') {
					if (resolution.status === 'resolved') {
						receiverResolvedCount++;
					}
				} else if (resolution.status === 'resolved') {
					resolvedCount++;
				}
				addEdge(edgesByKey, site.nodeId, fqn, EDGE_TYPES[site.kind], resolution);
			}
		} catch (error: unknown) {
			// One file's resolver failure must not cost the pass, matching
			// `runAstPass`'s handling of one unparseable file.
			onError?.(filePath, error instanceof Error ? error : new Error(String(error)));
		}

		processed++;
		onProgress?.(processed, sitesByFile.size, filePath);
		if (processed % YIELD_EVERY_FILES === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	return {
		nodes: [],
		edges: [...edgesByKey.values()],
		referenceSiteCount,
		resolvedCount,
		externalCount,
		fileCount: sitesByFile.size,
		receiverSiteCount,
		receiverResolvedCount,
	};
}

function addEdge(edgesByKey: Map<string, GraphEdge>, source: string, target: string, type: string, resolution: Resolution): void {
	const key = `${source}\0${target}\0${type}`;
	if (edgesByKey.has(key)) {
		return;
	}
	edgesByKey.set(key, {
		source,
		target,
		type,
		data: {
			resolution: {
				status: resolution.status,
				resolvedBy: resolution.resolvedBy,
				confidence: resolution.confidence,
				...(resolution.reason ? { reason: resolution.reason } : {}),
			},
		},
	});
}

/** `row:column` of a node's name-token start → its id, per file — the `RECEIVER` edge's exact-hit-only target lookup. Excludes `SYMBOL` nodes: `toSubgraph` stamps a symbol's `location` byte-identical to its defining `METHOD`/`TYPE_DECL`, and symbols are appended *after* AST nodes by `GraphBuilder.replaceFile`, so without this exclusion a symbol would silently win the position over the binding a `RECEIVER` edge actually needs to point at. */
function indexNodesByPosition(nodes: readonly GraphNode[]): Map<string, Map<string, string>> {
	const byFile = new Map<string, Map<string, string>>();
	for (const node of nodes) {
		if (node.type === 'SYMBOL') {
			continue;
		}
		const location = node.data?.location as { filePath?: string; nameRange?: { startRow: number; startColumn: number } } | undefined;
		const nameRange = location?.nameRange;
		if (!location?.filePath || !nameRange) {
			continue;
		}
		let byPosition = byFile.get(location.filePath);
		if (!byPosition) {
			byPosition = new Map();
			byFile.set(location.filePath, byPosition);
		}
		byPosition.set(positionKey(nameRange.startRow, nameRange.startColumn), node.id);
	}
	return byFile;
}

function positionKey(row: number, column: number): string {
	return `${row}:${column}`;
}

/**
 * The symbol a resolution points at.
 *
 * `target.fqn` wins when the resolver already knows it — a resolver that worked
 * through the definition index has it in hand. Otherwise the resolution carries
 * only a *location* (all a language server reports) and the index turns that
 * into the symbol defined there.
 *
 * Reading the definition's own minted fqn, rather than rebuilding one from the
 * reference's name, is what makes two same-named functions in one scope
 * distinguishable at all.
 */
/**
 * Records a reference's outcome on its own node.
 *
 * One `IMPORT` statement can hold several bindings that resolve differently, so
 * the first *unresolved* one is what gets kept: a statement that is partly
 * unresolved is more usefully reported as unresolved than as resolved.
 */
function annotate(nodeId: string | undefined, nodesById: Map<string, GraphNode>, resolution: Resolution): void {
	if (!nodeId) {
		return;
	}
	const node = nodesById.get(nodeId);
	if (!node) {
		return;
	}
	const data = (node.data ??= {});
	const existing = data.resolution as { status?: string } | undefined;
	if (existing && existing.status !== 'resolved') {
		return;
	}
	data.resolution = {
		status: resolution.status,
		resolvedBy: resolution.resolvedBy,
		confidence: resolution.confidence,
		...(resolution.reason ? { reason: resolution.reason } : {}),
	};
}

function symbolFor(resolution: Resolution, definitions: DefinitionLookup): string | undefined {
	if (resolution.target?.fqn) {
		return resolution.target.fqn;
	}
	const definition = resolution.definition;
	if (!definition) {
		return undefined;
	}
	return definitions.symbolAt(definition.filePath, definition.position.row, definition.position.column);
}

function groupByFile(sites: readonly RefSite[]): Map<string, RefSite[]> {
	const byFile = new Map<string, RefSite[]>();
	for (const site of sites) {
		const existing = byFile.get(site.filePath);
		if (existing) {
			existing.push(site);
		} else {
			byFile.set(site.filePath, [site]);
		}
	}
	return byFile;
}

