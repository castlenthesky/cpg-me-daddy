// Zero imports, deliberately. This file is required (or type-imported) from
// both a CommonJS/Node context (the extension host, @cpg/file-watcher) and a
// browser/ESM context (the webview) — pulling in anything else here would
// pull that dependency's runtime into whichever side merely wants the types.

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
/** Webview → extension host. */
export type WebviewToHost = { type: 'ready' };

/**
 * Merges a `GraphDelta` into a `GraphPayload`, dropping any edge that
 * touches a removed node. Shared by the extension host (to keep the
 * full-snapshot state it re-sends on webview reconnect up to date — see
 * `GraphViewProvider.postDelta`) and available to any other consumer that
 * needs the merged shape rather than the delta itself.
 */
export function applyGraphDelta(payload: GraphPayload, delta: GraphDelta): GraphPayload {
	const removed = new Set(delta.removedNodeIds);
	return {
		nodes: payload.nodes.filter((node) => !removed.has(node.id)).concat(delta.addedNodes),
		edges: payload.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)).concat(delta.addedEdges),
	};
}
