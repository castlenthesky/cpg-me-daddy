# @cpg/file-watcher

Status: partially implemented — backs ParseWorkspace/MonitorWorkspace.

## Files

- `index.ts` — barrel; exports `FileTreeNode`, `walkWorkspace`, `toGraphPayload`, `WorkspaceGraphIndex`, `parseWorkspace`, and re-exports `astPass.ts`/`changes.ts`/`monitor.ts`/`queue.ts`/`debounce.ts`.
- `astPass.ts` — `runAstPass`, the AST half of ParseWorkspace: parses every supported file in an already-walked tree and returns one merged `{ nodes, edges }` to concatenate onto the file/directory payload. The one-shot counterpart to `astPipeline.ts`'s per-event single-file run.
- `changes.ts` — types only: `ChangeKind`, `WorkspaceChange`, `WatchBackend`, `WatchSubscription`.
- `monitor.ts` — `monitorWorkspace`, the MonitorWorkspace routing layer; dispatches the async AST leg to `astPipeline.ts` and merges its removals via `@cpg/graph-builder`.
- `astPipeline.ts` — `AstPipeline`, the async CPG leg: `ast-generator.parseFile -> cpg-generator.toSubgraph -> graph-builder.replaceFile -> runResolvePass -> one GraphDelta`. Serializes runs per file path so two close-together saves can't apply out of order. The re-resolve is not optional in spirit: `replaceFile` re-mints the saved file's `CALL`/`IMPORT` ids, so `applyGraphDelta` drops their old edges as collateral and they must be re-created in the same delta. **Only the saved file is re-resolved** — references in *other* files pointing into it need nothing, because their edges name an fqn and an fqn doesn't change when this file is re-parsed.
- `debounce.ts` — `ChangeBatcher<T>`, a key-deduplicating batcher (100ms trailing / 500ms ceiling, injectable clock).
- `queue.ts` — `UpdateQueue`, currently pass-through.
- `resolvePass.ts` — `runResolvePass`, the **third** phase after ParseWorkspace's walk and AST pass: hands the payload's `CALL`/`IMPORT` nodes (plus, for a member-access `CALL`, its `receiver`/`receiver-type` sites) to a `Resolver` and turns the answers into deduplicated `CALLS`/`IMPORTS`/`RECEIVER`/`EVAL_TYPE` edges. `CALLS`/`IMPORTS`/`EVAL_TYPE` target `SYMBOL` nodes; `RECEIVER` is the exception — it targets an AST node id in the **same file** (an intra-file, exact-position index built fresh per pass, excluding `SYMBOL` nodes) and is never emitted cross-file, because `GraphDelta` has no `removedEdgeIds` to repair a swept AST-node edge with. It mints **no** symbol nodes — those come from whichever file *defines* them, via `toSubgraph`'s `symbols` channel. It also mirrors each `call`/`import` outcome onto the reference node's `data.resolution`, so an edge-less call can explain itself in the tooltip — `receiver`/`receiver-type` sites are excluded from this, since they share that node's `nodeId` and would otherwise be able to overwrite a cleanly-resolved call's own status.

## API

- `walkWorkspace(rootPath): FileTreeNode` — synchronous one-shot directory walk into `{ name, path, type, children? }`; skips `DEFAULT_IGNORED_DIRECTORIES` and the workspace root's `.gitignore`.
- `parseWorkspace(rootPath, options?): Promise<{ tree, payload, index, nodeCount, ast?, resolution? }>` — ParseWorkspace entry point: `walkWorkspace` → `toGraphPayload` → `WorkspaceGraphIndex`, then (only when `options.builder` is supplied) `runAstPass` over every supported file, with its nodes/edges appended to `payload` and its summary returned as `ast`, then (only when `options.resolver` is supplied too) `runResolvePass` over the finished payload, returned as `resolution`. `options`: `builder`, `resolver`, `onProgress`, `onAstError`, `onResolveProgress`, `onResolveError`, `maxAstNodes`, `token`.
- `runResolvePass(nodes, options): Promise<{ nodes, edges, referenceSiteCount, resolvedCount, fileCount, receiverSiteCount, receiverResolvedCount }>` (`resolvePass.ts`) — groups the payload's reference sites by file and calls `Resolver.resolve` once per file. Runs **after** the AST pass, not during it: a call in the first file walked can target a definition in the last, so resolving mid-walk would report `unresolved` for resolvable references, non-deterministically by walk order. One file's resolver failure reaches `onError` and the pass continues, matching `runAstPass`. `receiverSiteCount`/`receiverResolvedCount` are counted separately from `referenceSiteCount`/`resolvedCount`: a receiver bound by a function parameter has no node to point at and can never resolve, and folding it into the same denominator would make the headline ratio incomparable to a run before this existed.
- `runAstPass(tree, options?): Promise<{ nodes, edges, parsedFileCount, supportedFileCount, truncated }>` (`astPass.ts`) — the AST pass itself. Parses depth-first in `walkWorkspace` order, yields to the event loop every 10 files, reports a failed file to `onError` and continues, and stops early on a cancelled `token` or on `maxNodes` (`DEFAULT_MAX_AST_NODES`, 20 000 — a workspace-wide ceiling distinct from `toSubgraph`'s per-file 500).
- `toGraphPayload(tree): GraphPayload` — flattens a tree into `@cpg/graph-visualizer`'s `{ nodes, edges }` shape; import `GraphPayload` from `@cpg/graph-visualizer/dist/contract`, not the barrel.
- `WorkspaceGraphIndex.applyChange(path): GraphDelta | undefined` — rescans the nearest indexed ancestor directory and diffs against the cached listing; idempotent (safe to replay).
- `WorkspaceGraphIndex.applyMove(from, to): GraphDelta | undefined` — merges remove+add via `applyChange`; not position-preserving (a rename looks like churn, not a move).
- `WatchBackend.subscribe(rootPath, onChange, onError?): WatchSubscription` — backend seam; only implementation is `src/watch/vscodeWatchBackend.ts`'s `VsCodeWatchBackend`.
- `monitorWorkspace(rootPath, index, backend, options?: MonitorOptions): WatchSubscription` — batches changes via `ChangeBatcher`, routes `'created'`/`'deleted'` to `applyChange`, `'moved'` to `applyMove`. `MonitorOptions.builder` (a `@cpg/graph-builder` `GraphBuilder`) is what turns the AST leg on: when supplied, `'created'`/`'changed'`/`'moved'` are also handed to an `AstPipeline`, and a `'deleted'`/`'moved'` presence delta has its removed file's AST ids swept in via `builder.removeUnder` before being emitted (so a deleted file's AST subtree doesn't linger as an orphan). Omitting `builder` disables the AST leg entirely (no dump, no AST delta) — used by any caller with no interest in it. `MonitorOptions.dumpAstToDisk` (default `true`) and `astOutputDir` (default `<rootPath>/out/ast`) control the debug JSON dump.
- `UpdateQueue` (`queue.ts`) — pass-through; `enqueue` delivers immediately, `pause()`/`resume()` exist but are unused.

## Testing

`monitorWorkspace` takes a `WatchBackend`, so tests can drive it with a fake `subscribe()`; `ChangeBatcher` accepts an injected clock. No test runner wired in yet.

## Gotchas

- `parseWorkspace` and `monitorWorkspace` must be given the **same** `GraphBuilder` instance (`WorkspaceSession` owns it and passes it to both). With two instances, MonitorWorkspace treats every file's first save as its first parse and the ParseWorkspace-era AST nodes linger as duplicates.
- The directory walk snapshots the workspace before the AST pass runs, and the watcher only subscribes after `parseWorkspace` resolves — edits in that window are seen by neither phase. Closing it is the `UpdateQueue` `pause()`/`resume()` migration.
- Only the workspace root's `.gitignore` is honored, read once at walk/watch start.
- `createIgnoreFilter` can't distinguish a file from a directory for a deleted watcher-event path, so directory-only patterns (e.g. `build/`) may misfire.
- `loadGitignore`/`isIgnoredChange`/`IgnoreMatcher` are intentionally not exported — only `createIgnoreFilter(rootPath)` is, to keep the `ignore` package's default-export type out of this package's public `.d.ts`.
- `VsCodeWatchBackend` only fires renames done through VS Code itself; a terminal `mv`/`git mv` arrives as `'deleted'`+`'created'` instead.
