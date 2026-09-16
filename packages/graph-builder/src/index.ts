import { sep } from 'node:path';
// Type-only, deep import — same rule as `@cpg/cpg-generator`'s subgraph.ts (see
// packages/graph-visualizer/CLAUDE.md "Gotchas"): keeps the DOM-typed barrel and its
// `@cosmos.gl/graph` dependency out of this Node-only package.
import type { GraphDelta, GraphEdge, GraphNode, NodeLocation, SourceRange } from '@cpg/graph-visualizer/dist/contract';

export interface CpgSubgraphLike {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/**
	 * Cross-file symbols this file defines. A **separate channel from `nodes`**,
	 * and that separation is the one-line invariant the whole cross-file design
	 * rests on.
	 *
	 * `idsByFile` is populated from `nodes` alone. A `SYMBOL` listed there would
	 * be owned by this file, so the next `replaceFile` for it would name the
	 * symbol in `removedNodeIds` — and `applyGraphDelta` drops any edge with a
	 * removed endpoint, so *another* file's `CALLS` edge into that symbol would
	 * be deleted as collateral, permanently, with nothing to re-add it. Keeping
	 * symbols out of `nodes` means no file can own one, so no code path can
	 * sweep one.
	 */
	symbols?: readonly SymbolRef[];
}

/** A symbol one file defines. Structurally matches `@cpg/cpg-generator`'s `CpgSymbol`, without this package depending on it. */
export interface SymbolRef {
	/** The symbol's id, which is its fqn verbatim. Stable across edits elsewhere in the defining file — that is what lets cross-file edges survive a re-parse. */
	fqn: string;
	/** Trailing descriptor only, e.g. `generate_greeting()`. */
	name: string;
	/** The definition's own location, so clicking the symbol jumps to where it is declared. */
	location?: NodeLocation;
}

/** The node type of a minted symbol. Registered in `@cpg/graph-visualizer`'s `NODE_TYPES` for its colour and legend row. */
export const SYMBOL_NODE_TYPE = 'SYMBOL';

interface FileDefinitions {
	/** `row:column` of a definition's name token → its fqn. The exact-hit path. */
	byStart: Map<string, string>;
	/** Bare identifier → fqn, for a resolver that has a module file but no position. First declaration wins, so the answer is deterministic. */
	byName: Map<string, string>;
	/** Definition extents, for the containment fallback when a provider returns a construct rather than its name token. */
	extents: Array<{ range: SourceRange; fqn: string }>;
}

/**
 * Owns which AST node ids are currently on screen for each file, so a re-parse or a deletion can
 * remove exactly the ids that file previously contributed rather than the whole graph. This is the
 * second leg of the pipeline `@cpg/file-watcher/src/monitor.ts` names in its SEAT comment:
 * `ast-generator.parse -> cpg-generator.toSubgraph -> graph-builder.replaceFile -> a GraphDelta`.
 *
 * It also owns symbol lifetime, which follows a deliberately different rule —
 * see `syncSymbols` — and the definition index that turns a resolver's
 * "the definition is at file:row:col" into "…which is this symbol".
 */
export class GraphBuilder {
	private readonly idsByFile = new Map<string, string[]>();
	/** file → fqns it defines. */
	private readonly symbolsByFile = new Map<string, Set<string>>();
	/** fqn → files defining it. A symbol lives while this is non-empty. */
	private readonly filesBySymbol = new Map<string, Set<string>>();
	/** fqn → the rendered node, kept so a symbol is emitted once and never re-added while it survives. */
	private readonly symbolNodes = new Map<string, GraphNode>();
	private readonly definitionsByFile = new Map<string, FileDefinitions>();

	/**
	 * Replaces one file's AST subgraph. The ids it previously contributed (empty on a first parse)
	 * are removed and the new subgraph is added in the *same* delta, so
	 * `@cpg/graph-visualizer`'s incremental `applyDelta` can restore an id that recurs across the
	 * old and new subgraph in place, rather than tombstoning it and appending a duplicate.
	 */
	replaceFile(filePath: string, subgraph: CpgSubgraphLike): GraphDelta {
		const removedNodeIds = this.idsByFile.get(filePath) ?? [];
		this.idsByFile.set(
			filePath,
			subgraph.nodes.map((node) => node.id)
		);
		const symbols = subgraph.symbols ?? [];
		this.indexDefinitions(filePath, symbols);
		const synced = this.syncSymbols(filePath, symbols);
		return {
			// Symbol nodes go last, and that ordering is load-bearing:
			// `applyDeltaInternal` seeds a new node's position from its parent's
			// via an index it builds while walking `addedNodes`, so a symbol
			// listed before the `METHOD` that defines it would seed at the space
			// centre instead of beside its definition.
			addedNodes: [...subgraph.nodes, ...synced.addedNodes],
			addedEdges: subgraph.edges,
			removedNodeIds: [...removedNodeIds, ...synced.orphanedSymbolIds],
		};
	}

	/** Removes one file's AST nodes outright — e.g. once its own file node is already confirmed gone. Returns `undefined` when the file had no tracked AST (nothing to remove). */
	removeFile(filePath: string): GraphDelta | undefined {
		const removedNodeIds = this.idsByFile.get(filePath);
		if (!removedNodeIds) {
			return undefined;
		}
		this.idsByFile.delete(filePath);
		this.definitionsByFile.delete(filePath);
		const orphaned = this.releaseSymbols(filePath);
		return { addedNodes: [], addedEdges: [], removedNodeIds: [...removedNodeIds, ...orphaned] };
	}

	/**
	 * Sweeps every tracked file whose path is, or falls under, one of `removedIds`. A file/directory
	 * `GraphDelta` (from `WorkspaceGraphIndex.applyChange`/`applyMove`) names only the removed
	 * file/directory node itself — never the AST ids hanging off it — so merging that delta as-is
	 * would leave a deleted file's (or an entire deleted directory's descendants') AST nodes orphaned
	 * on screen once their file node is gone. Call this with a presence delta's `removedNodeIds`
	 * *before* forwarding it, and fold the result into that same list.
	 *
	 * Symbols defined by a swept file are released the same way, so the returned
	 * list also carries any fqn that just lost its last definer. Both kinds
	 * belong in `removedNodeIds`, so the return type stays `string[]` and
	 * callers need no change.
	 */
	removeUnder(removedIds: string[]): string[] {
		const removed: string[] = [];
		for (const removedId of removedIds) {
			for (const [filePath, ids] of this.idsByFile) {
				if (filePath === removedId || filePath.startsWith(removedId + sep)) {
					removed.push(...ids);
					this.idsByFile.delete(filePath);
					this.definitionsByFile.delete(filePath);
					removed.push(...this.releaseSymbols(filePath));
				}
			}
		}
		return removed;
	}

	/**
	 * REAL — `idsByFile` has an entry for every file `replaceFile` has ever been
	 * called with, including one that yielded no nodes at all (see `runAstPass`'s
	 * note on registering empties). So this is already the honest answer to "did
	 * we parse this file into the graph?", which is the question that separates
	 * *"there is no definition there"* (`unresolved`) from *"we never looked"*
	 * (`external`).
	 */
	isIndexed(filePath: string): boolean {
		return this.idsByFile.has(filePath);
	}

	/**
	 * The reverse of `data.location`: a resolver says "the definition is at
	 * file:row:col", and this says which symbol that is.
	 *
	 * Two tiers. The exact hit keys on the definition's **name token** start,
	 * which is what `textDocument/definition` reports for both Pylance and
	 * tsserver, and what a `LocationLink`'s `targetSelectionRange` carries.
	 * Some providers instead return the whole declaration, so the fallback is
	 * the most tightly enclosing definition extent — linear over one file's
	 * definitions, and only paid on a miss.
	 */
	symbolAt(filePath: string, row: number, column: number): string | undefined {
		const definitions = this.definitionsByFile.get(filePath);
		if (!definitions) {
			return undefined;
		}
		const exact = definitions.byStart.get(positionKey(row, column));
		if (exact) {
			return exact;
		}
		let best: { range: SourceRange; fqn: string } | undefined;
		for (const candidate of definitions.extents) {
			if (!containsPosition(candidate.range, row, column)) {
				continue;
			}
			if (!best || isTighter(candidate.range, best.range)) {
				best = candidate;
			}
		}
		return best?.fqn;
	}

	/** The fqn of a definition in this file by bare name — for a resolver that has picked a module file but has no position to offer. */
	symbolNamed(filePath: string, name: string): string | undefined {
		return this.definitionsByFile.get(filePath)?.byName.get(name);
	}

	/** The rendered node for an fqn, for a pass that needs to emit an edge to a symbol another file defined. */
	symbolNode(fqn: string): GraphNode | undefined {
		return this.symbolNodes.get(fqn);
	}

	/**
	 * Whether a symbol node currently exists for this fqn.
	 *
	 * This is the authority a resolve pass checks before emitting an edge, and
	 * it has to be the builder rather than the payload: a per-save re-resolve
	 * sees only the one file's delta, yet needs to link into symbols every other
	 * file defined. The builder's table and the rendered payload stay in step
	 * because every symbol node reaches the payload through a delta this class
	 * produced.
	 */
	hasSymbol(fqn: string): boolean {
		return this.symbolNodes.has(fqn);
	}

	private indexDefinitions(filePath: string, symbols: readonly SymbolRef[]): void {
		if (symbols.length === 0) {
			this.definitionsByFile.delete(filePath);
			return;
		}
		const definitions: FileDefinitions = { byStart: new Map(), byName: new Map(), extents: [] };
		for (const symbol of symbols) {
			const location = symbol.location;
			if (!location) {
				continue;
			}
			const nameRange = location.nameRange ?? location.range;
			definitions.byStart.set(positionKey(nameRange.startRow, nameRange.startColumn), symbol.fqn);
			definitions.extents.push({ range: location.range, fqn: symbol.fqn });
			const bare = bareName(symbol.name);
			// First declaration wins, so a rebound name resolves deterministically
			// rather than depending on map insertion order.
			if (!definitions.byName.has(bare)) {
				definitions.byName.set(bare, symbol.fqn);
			}
		}
		this.definitionsByFile.set(filePath, definitions);
	}

	/**
	 * Symbols are *shared*, so `replaceFile`'s "this file owns these ids" model
	 * is the wrong lifetime for them: `main.py` and three other files can all
	 * reference one `generate_greeting`, and a re-parse of the file that defines
	 * it must not take the symbol — or anyone else's edge to it — off screen.
	 *
	 * The diff has three cases and the third is the one that matters:
	 * newly-defined fqns are added (and emitted only if no other file already
	 * defines them), no-longer-defined fqns are released and removed only once
	 * their last definer is gone, and an fqn present both before and after is
	 * **left strictly alone** — not re-added — so it keeps its visualizer index,
	 * its position, and every inbound edge from every other file. That third
	 * case is precisely what makes a save of the defining file invisible to its
	 * callers.
	 */
	private syncSymbols(filePath: string, symbols: readonly SymbolRef[]): { addedNodes: GraphNode[]; orphanedSymbolIds: string[] } {
		const previous = this.symbolsByFile.get(filePath) ?? new Set<string>();
		const next = new Set(symbols.map((symbol) => symbol.fqn));
		const addedNodes: GraphNode[] = [];

		for (const symbol of symbols) {
			if (previous.has(symbol.fqn)) {
				continue;
			}
			const definers = this.filesBySymbol.get(symbol.fqn);
			if (definers) {
				definers.add(filePath);
				continue;
			}
			this.filesBySymbol.set(symbol.fqn, new Set([filePath]));
			const node: GraphNode = {
				id: symbol.fqn,
				type: SYMBOL_NODE_TYPE,
				name: symbol.name,
				data: { fqn: symbol.fqn, ...(symbol.location ? { location: symbol.location } : {}) },
			};
			this.symbolNodes.set(symbol.fqn, node);
			addedNodes.push(node);
		}

		const orphanedSymbolIds: string[] = [];
		for (const fqn of previous) {
			if (next.has(fqn)) {
				continue;
			}
			const definers = this.filesBySymbol.get(fqn);
			definers?.delete(filePath);
			if (!definers || definers.size === 0) {
				this.filesBySymbol.delete(fqn);
				this.symbolNodes.delete(fqn);
				orphanedSymbolIds.push(fqn);
			}
		}

		this.symbolsByFile.set(filePath, next);
		return { addedNodes, orphanedSymbolIds };
	}

	/** Drops one file's symbol references entirely, returning the fqns that just lost their last definer. */
	private releaseSymbols(filePath: string): string[] {
		const previous = this.symbolsByFile.get(filePath);
		if (!previous) {
			return [];
		}
		this.symbolsByFile.delete(filePath);
		const orphaned: string[] = [];
		for (const fqn of previous) {
			const definers = this.filesBySymbol.get(fqn);
			definers?.delete(filePath);
			if (!definers || definers.size === 0) {
				this.filesBySymbol.delete(fqn);
				this.symbolNodes.delete(fqn);
				orphaned.push(fqn);
			}
		}
		return orphaned;
	}
}

function positionKey(row: number, column: number): string {
	return `${row}:${column}`;
}

/** `generate_greeting()` → `generate_greeting`. Symbol display names carry a method's parens; a resolver asks by bare identifier. */
function bareName(name: string): string {
	return name.endsWith('()') ? name.slice(0, -2) : name;
}

function containsPosition(range: SourceRange, row: number, column: number): boolean {
	if (row < range.startRow || row > range.endRow) {
		return false;
	}
	if (row === range.startRow && column < range.startColumn) {
		return false;
	}
	if (row === range.endRow && column > range.endColumn) {
		return false;
	}
	return true;
}

function isTighter(candidate: SourceRange, incumbent: SourceRange): boolean {
	const candidateRows = candidate.endRow - candidate.startRow;
	const incumbentRows = incumbent.endRow - incumbent.startRow;
	if (candidateRows !== incumbentRows) {
		return candidateRows < incumbentRows;
	}
	return candidate.endColumn - candidate.startColumn < incumbent.endColumn - incumbent.startColumn;
}
