# src/

Extension host + webview UI. Two separate compile targets share this tree.

## Files

- `extension.ts` — activation entry (`main`); constructs a `WorkspaceSession` for the first workspace folder and calls `start()`; posts the initial snapshot via `GraphViewProvider.postGraph`, then deltas via `postDelta`.
- `workspaceSession.ts` — `WorkspaceSession`, orders ParseWorkspace → MonitorWorkspace (`@cpg/file-watcher`) for one workspace folder; holds an `UpdateQueue` and the one `GraphBuilder` both phases share (see that package's "Gotchas").
- `watch/vscodeWatchBackend.ts` — `VsCodeWatchBackend`, the only file here that imports `vscode`'s watcher APIs; implements `@cpg/file-watcher`'s `WatchBackend` seam.
- `resolve/vscodeDefinitionResolver.ts` — `VsCodeDefinitionResolver`, `REAL`: the only file that knows `vscode.executeDefinitionProvider`/`executeTypeDefinitionProvider` exist, implementing `@cpg/cpg-generator`'s `Resolver` seam. Wired at the **front** of `extension.ts`'s `ChainResolver`, ahead of `PythonPathResolver` — `ChainResolver` keeps the first real *answer* per site (`unresolved`/`dynamic` still fall through), so the filesystem link keeps answering for workspaces a type checker resolves nothing in. Bounded-concurrency batches per file (all parallelism lives inside `resolve()`, since `runResolvePass` awaits one file at a time); a lazy, budget-bounded warm-up probe on the first site of the first file, since there is no public "language server is ready" API; an out-of-workspace definition (a builtin, a stub) comes back `unresolved`, not `external`, so `PythonPathResolver`'s own classification (e.g. `print` as a builtin) still runs behind it. No position cache — nothing calls `fileChanged` with real content today. Its biggest win is member-access calls (`greeter.greet()`), which `PythonPathResolver` deliberately refuses to guess at.
- `dev/resolveHarness.ts`, `dev/fakeResolver.ts` — run the real pipeline over a real workspace with everything except `vscode`, substituting only the `Resolver`. `npm run verify:resolve`. There is no test runner in this repo; this is the gate that lets symbol identity be checked without launching an Extension Development Host. Excluded from the VSIX via `.vscodeignore`.
- `views/graphViewProvider.ts` — `WebviewViewProvider` for the "Graph" panel; renders `@cpg/graph-visualizer`'s HTML shell and holds the webview message channel (`postGraph`/`postDelta`).
- `views/logsTreeProvider.ts` — `TreeDataProvider` for the "Insights" panel (rolling in-memory log, capped at 200 entries).
- `views/placeholderTreeProvider.ts` — generic stub `TreeDataProvider` used by the "Config" panel.
- `webview/graphApp.ts` — runs inside the webview; thin glue that mounts `@cpg/graph-visualizer`'s `GraphVisualizer` and forwards `graph`/`graph-delta` messages into it.

## Two compile targets, don't mix them

- `src/**` except `src/webview/**` compiles via the root `tsconfig.json` (Node/CommonJS) into `out/`.
- `src/webview/**` is bundled by `esbuild.js` (browser, IIFE) into `out/webview/graph.js`.
- `webview/` code cannot use `vscode`/Node APIs; code outside `webview/` cannot assume a DOM.

Webview messaging contract is defined in `@cpg/graph-visualizer`'s `contract.ts` (`HostToWebview`/`WebviewToHost`): host→webview is `{ type: 'graph', payload }` or `{ type: 'graph-delta', delta }`; webview→host is `{ type: 'ready' }` or `{ type: 'reveal', nodeId }`.

## Click-to-navigate

Clicking a graph node opens its source. The click travels `GraphVisualizer`'s `onNodeClick` seam → `graphApp.ts` posts `{ type: 'reveal', nodeId }` → `GraphViewProvider.revealNode`. Only the id is sent: the host resolves it against `lastPayload` (already kept merged for reconnects), so there's one source of truth for where a node points.

`revealNode` selects the node's `nameRange` (the identifier — `foo`, not the `function` keyword) and then `revealRange`s the full `range`, so the caret lands on the token while the whole construct frames. A `file` node has no stored location and opens by its id (which is its path); a `directory` node opens nothing.
