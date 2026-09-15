# src/

Extension host + webview UI. Two separate compile targets share this tree.

## Files

- `extension.ts` — activation entry (`main`); constructs a `WorkspaceSession` for the first workspace folder and calls `start()`; posts the initial snapshot via `GraphViewProvider.postGraph`, then deltas via `postDelta`.
- `workspaceSession.ts` — `WorkspaceSession`, orders ParseWorkspace → MonitorWorkspace (`@cpg/file-watcher`) for one workspace folder; holds an `UpdateQueue`.
- `watch/vscodeWatchBackend.ts` — `VsCodeWatchBackend`, the only file here that imports `vscode`'s watcher APIs; implements `@cpg/file-watcher`'s `WatchBackend` seam.
- `views/graphViewProvider.ts` — `WebviewViewProvider` for the "Graph" panel; renders `@cpg/graph-visualizer`'s HTML shell and holds the webview message channel (`postGraph`/`postDelta`).
- `views/logsTreeProvider.ts` — `TreeDataProvider` for the "Insights" panel (rolling in-memory log, capped at 200 entries).
- `views/placeholderTreeProvider.ts` — generic stub `TreeDataProvider` used by the "Config" panel.
- `webview/graphApp.ts` — runs inside the webview; thin glue that mounts `@cpg/graph-visualizer`'s `GraphVisualizer` and forwards `graph`/`graph-delta` messages into it.

## Two compile targets, don't mix them

- `src/**` except `src/webview/**` compiles via the root `tsconfig.json` (Node/CommonJS) into `out/`.
- `src/webview/**` is bundled by `esbuild.js` (browser, IIFE) into `out/webview/graph.js`.
- `webview/` code cannot use `vscode`/Node APIs; code outside `webview/` cannot assume a DOM.

Webview messaging contract is defined in `@cpg/graph-visualizer`'s `contract.ts` (`HostToWebview`/`WebviewToHost`): host→webview is `{ type: 'graph', payload }` or `{ type: 'graph-delta', delta }`; webview→host is `{ type: 'ready' }`.
