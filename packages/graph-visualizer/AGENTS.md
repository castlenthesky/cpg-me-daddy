# @cpg/graph-visualizer

Status: partially implemented — owns the graph view layer (cosmos.gl render, legend, webview HTML shell). Only knows `'file' | 'directory'` node types today.

## API (`src/index.ts`)

- `GraphPayload` / `GraphNode` / `GraphEdge` (`contract.ts`) — the render data shape; `GraphNode.type` drives colour/legend grouping, `GraphNode.name` is the tooltip display name (never a full path — that's `id`).
- `GraphDelta` / `applyGraphDelta` (`contract.ts`) — incremental `{ addedNodes, addedEdges, removedNodeIds }`; removed edges are implicit (dropped when a touched node is removed).
- `GraphVisualizer` (`visualizer.ts`) — mounts on an `HTMLDivElement`; `render(payload)` full-draws via cosmos.gl, `applyDelta(delta)` patches in place, `fitView()`/`dispose()` manage the camera/WebGL context.
- `graphWebviewHtml(opts)` (`shell.ts`) — the webview HTML shell (CSP, sizing CSS, mount `<div>`).
- `layoutPayload(payload, hierarchyEdgeType?)` (`layout.ts`) — pure layout math, exported for isolated testing.
- `NODE_TYPES` (`nodeTypes.ts`) — the colour/label registry; extend here when CPG node types beyond file/directory arrive.

## Gotchas

- The repo's only browser-targeted package: `"lib": ["ES2022", "DOM"]`, `"types": []`, still emits CommonJS.
- `contract.ts` and `shell.ts` must stay import-free — the CommonJS extension host deep-imports `dist/contract`/`dist/shell` instead of the ESM-only main entry.
- Multi-root layouts place a synthetic centre node with no real edge to the visible roots — not visually polished.
- `hiddenTypes` (legend show/hide) persists per-instance across `render()` calls.
- `NODE_TYPES[].label` (a type's legend label) and `GraphNode.name` (a single node's display name) are unrelated despite similar names.
