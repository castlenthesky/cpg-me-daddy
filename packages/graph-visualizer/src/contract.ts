// Zero imports, deliberately. This file is required (or type-imported) from
// both a CommonJS/Node context (the extension host, @cpg/file-watcher) and a
// browser/ESM context (the webview) — pulling in anything else here would
// pull that dependency's runtime into whichever side merely wants the types.

/**
 * A range in a source file, in exactly the coordinate system
 * `vscode.Position` uses: zero-based rows, and columns counted in UTF-16 code
 * units (not bytes, and not codepoints).
 *
 * That match is not a coincidence worth relying on silently: tree-sitter's
 * core counts columns in bytes, but its web binding feeds the source in as
 * UTF-16 and converts the offsets back on the way out, so what
 * `@cpg/ast-generator` reports is already UTF-16 code units. A range
 * therefore travels from the parser to `new vscode.Position(row, column)`
 * with no conversion, and a line containing an emoji or an accented character
 * can't shift the cursor. Verified empirically rather than assumed — if the
 * parser is ever swapped for one reporting byte columns, this is the type
 * whose contract breaks, and every consumer below inherits the bug.
 */
export interface SourceRange {
	startRow: number;
	startColumn: number;
	endRow: number;
	endColumn: number;
}

/**
 * Everything the extension host needs to open a node's source and put the
 * cursor on it — carried in `GraphNode.data.location` (see `nodeLocation`
 * below, which is how it should be read back).
 *
 * `range` is the construct's full extent (the whole method, the whole class)
 * and is what to frame in the viewport. `nameRange` is the construct's
 * identifier token — `foo` in `function foo()`, the callee chain in a call —
 * and is where the cursor actually belongs: a method's `range` starts on the
 * `function` keyword, so revealing by `range` alone lands the caret one token
 * short of what the user clicked. It's optional because not every construct
 * has a name-shaped child (an import statement, an anonymous arrow function),
 * in which case `range` is the only sensible target.
 */
export interface NodeLocation {
	/** Absolute path, the same one that is the file node's own `id`. */
	filePath: string;
	range: SourceRange;
	nameRange?: SourceRange;
}

/**
 * A single graph node. `type` drives both the point colour (see `nodeTypes.ts`)
 * and the legend grouping — today it's `'file' | 'directory'`, but nothing
 * here constrains it: CPG labels (`METHOD`, `TYPE_DECL`, `CALL`, …) are meant
 * to arrive as more producers come online.
 */
export interface GraphNode {
	/** Unique across the whole payload. A file path today. */
	id: string;
	type: string;
	/**
	 * Short display name — the basename for files/directories, never a full
	 * path (that's `id`). Falls back to `id` if omitted.
	 */
	name?: string;
	data?: Record<string, unknown>;
}

/**
 * A single graph edge. `type` is optional free-form metadata (`'AST'`,
 * `'CFG'`, `'REACHING_DEF'`, …); edges of the visualizer's configured
 * hierarchy edge type (`'CONTAINS'` by default) additionally seed the radial
 * layout — see `layoutPayload` in `layout.ts`.
 */
export interface GraphEdge {
	source: string;
	target: string;
	type?: string;
	/**
	 * Open property bag, same contract as `GraphNode.data` — read back through a
	 * typed accessor (`edgeResolution`) rather than by indexing, so only one
	 * place knows each key's shape.
	 *
	 * Nothing in the renderer reads it, and that is not an oversight: the link
	 * buffers are flat `Float32Array`s of endpoint indices, so there is no
	 * per-link slot for a property to occupy, and link colour is derived from
	 * the two endpoints (`linkColorInterpolateFromEndpoints`) rather than set
	 * per link. So this is a home for provenance a *producer* needs to keep and
	 * a *host* may want to surface — not a rendering channel.
	 */
	data?: Record<string, unknown>;
}

/** How confident a cross-reference edge is, and who decided. Mirrors the resolution vocabulary `@cpg/cpg-generator` produces. */
export interface EdgeResolution {
	status: string;
	/** The `Resolver.id` that produced this answer, so provenance is inspectable per edge rather than per run. */
	resolvedBy: string;
	confidence?: number;
	reason?: string;
}

/**
 * Reads back the resolution a producer stored on a reference node — how a
 * `CALL`/`IMPORT` explains itself when it has no outgoing edge.
 *
 * Mirrored onto the node as well as the edge because the interesting cases are
 * exactly the ones with *no* edge: a builtin, or a reference nothing could
 * resolve. Edge-only provenance can't describe an absent edge.
 */
export function nodeResolution(node: GraphNode): EdgeResolution | undefined {
	return readResolution(node.data?.resolution);
}

/** Reads back what a producer stored in `edge.data` — the mirror of `nodeLocation`, and the only place that knows the key and shape. */
export function edgeResolution(edge: GraphEdge): EdgeResolution | undefined {
	return readResolution(edge.data?.resolution);
}

function readResolution(resolution: unknown): EdgeResolution | undefined {
	if (typeof resolution !== 'object' || resolution === null) {
		return undefined;
	}
	const candidate = resolution as Record<string, unknown>;
	if (typeof candidate.status !== 'string' || typeof candidate.resolvedBy !== 'string') {
		return undefined;
	}
	return {
		status: candidate.status,
		resolvedBy: candidate.resolvedBy,
		...(typeof candidate.confidence === 'number' ? { confidence: candidate.confidence } : {}),
		...(typeof candidate.reason === 'string' ? { reason: candidate.reason } : {}),
	};
}

export interface GraphPayload {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/**
 * The minimal add/remove needed to bring a previously-sent `GraphPayload` up
 * to date, instead of resending the whole workspace on every change. Removed
 * edges are never listed explicitly — `removedNodeIds` implies them, since an
 * edge touching a removed node can't meaningfully remain (see
 * `applyGraphDelta` below and `GraphVisualizer.applyDelta`, which both drop
 * such edges rather than requiring the producer to enumerate them).
 */
export interface GraphDelta {
	addedNodes: GraphNode[];
	addedEdges: GraphEdge[];
	removedNodeIds: string[];
}

/** Extension host → webview. */
export type HostToWebview = { type: 'graph'; payload: GraphPayload } | { type: 'graph-delta'; delta: GraphDelta };
/**
 * Webview → extension host.
 *
 * `reveal` carries only the node id, never the location itself: the host
 * already holds the authoritative merged payload (see
 * `GraphViewProvider.postDelta`) and resolves the id against it, so there is
 * one source of truth for where a node points and no way for a stale webview
 * to ask the host to open a range that no longer exists.
 */
export type WebviewToHost = { type: 'ready' } | { type: 'reveal'; nodeId: string };

/**
 * Merges a `GraphDelta` into a `GraphPayload`, dropping any edge that
 * touches a removed node. Shared by the extension host (to keep the
 * full-snapshot state it re-sends on webview reconnect up to date — see
 * `GraphViewProvider.postDelta`) and available to any other consumer that
 * needs the merged shape rather than the delta itself.
 */
function isSourceRange(value: unknown): value is SourceRange {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const range = value as Record<string, unknown>;
	return (
		typeof range.startRow === 'number' &&
		typeof range.startColumn === 'number' &&
		typeof range.endRow === 'number' &&
		typeof range.endColumn === 'number'
	);
}

/**
 * Reads back the `NodeLocation` a producer stored in `node.data.location`, or
 * `undefined` for a node that has none.
 *
 * `GraphNode.data` is deliberately an open `Record<string, unknown>` bag, so
 * this is the one place that knows the key and shape — the alternative is
 * every consumer hand-casting the same untyped fields and drifting from the
 * producer. A `undefined` result is routine, not an error: `directory` nodes
 * have no source position at all, and a `file` node doesn't need one (its
 * `id` is already the path — see `GraphViewProvider.revealNode`, which falls
 * back to opening the file itself).
 */
export function nodeLocation(node: GraphNode): NodeLocation | undefined {
	const location = node.data?.location;
	if (typeof location !== 'object' || location === null) {
		return undefined;
	}
	const candidate = location as Record<string, unknown>;
	if (typeof candidate.filePath !== 'string' || !isSourceRange(candidate.range)) {
		return undefined;
	}
	return {
		filePath: candidate.filePath,
		range: candidate.range,
		...(isSourceRange(candidate.nameRange) ? { nameRange: candidate.nameRange } : {}),
	};
}

export function applyGraphDelta(payload: GraphPayload, delta: GraphDelta): GraphPayload {
	const removed = new Set(delta.removedNodeIds);
	return {
		nodes: payload.nodes.filter((node) => !removed.has(node.id)).concat(delta.addedNodes),
		edges: payload.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)).concat(delta.addedEdges),
	};
}
