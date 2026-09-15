# @cpg/file-watcher

Status: partially implemented — backs ParseWorkspace/MonitorWorkspace.

## Files

- `index.ts` — barrel; exports `FileTreeNode`, `walkWorkspace`, `toGraphPayload`, `WorkspaceGraphIndex`, `parseWorkspace`, and re-exports `changes.ts`/`monitor.ts`/`queue.ts`/`debounce.ts`.
- `changes.ts` — types only: `ChangeKind`, `WorkspaceChange`, `WatchBackend`, `WatchSubscription`.
- `monitor.ts` — `monitorWorkspace`, the MonitorWorkspace routing layer.
- `debounce.ts` — `ChangeBatcher<T>`, a key-deduplicating batcher (100ms trailing / 500ms ceiling, injectable clock).
- `queue.ts` — `UpdateQueue`, currently pass-through.

## API

- `walkWorkspace(rootPath): FileTreeNode` — synchronous one-shot directory walk into `{ name, path, type, children? }`; skips `DEFAULT_IGNORED_DIRECTORIES` and the workspace root's `.gitignore`.
- `parseWorkspace(rootPath, onProgress?, token?): Promise<{ tree, payload, index, nodeCount }>` — ParseWorkspace entry point; delegates to `walkWorkspace`, `onProgress`/`token` currently unused.
- `toGraphPayload(tree): GraphPayload` — flattens a tree into `@cpg/graph-visualizer`'s `{ nodes, edges }` shape; import `GraphPayload` from `@cpg/graph-visualizer/dist/contract`, not the barrel.
- `WorkspaceGraphIndex.applyChange(path): GraphDelta | undefined` — rescans the nearest indexed ancestor directory and diffs against the cached listing; idempotent (safe to replay).
- `WorkspaceGraphIndex.applyMove(from, to): GraphDelta | undefined` — merges remove+add via `applyChange`; not position-preserving (a rename looks like churn, not a move).
- `WatchBackend.subscribe(rootPath, onChange, onError?): WatchSubscription` — backend seam; only implementation is `src/watch/vscodeWatchBackend.ts`'s `VsCodeWatchBackend`.
- `monitorWorkspace(rootPath, index, backend, onDelta?, onError?, onAstDump?, onAstTrigger?): WatchSubscription` — batches changes via `ChangeBatcher`, routes `'created'`/`'deleted'` to `applyChange`, `'moved'` to `applyMove`, and `'created'`/`'changed'`/`'moved'` to `maybeDumpAst` (writes AST JSON to `<rootPath>/out/ast/`); `'deleted'` never dumps.
- `UpdateQueue` (`queue.ts`) — pass-through; `enqueue` delivers immediately, `pause()`/`resume()` exist but are unused.

## Testing

`monitorWorkspace` takes a `WatchBackend`, so tests can drive it with a fake `subscribe()`; `ChangeBatcher` accepts an injected clock. No test runner wired in yet.

## Gotchas

- Only the workspace root's `.gitignore` is honored, read once at walk/watch start.
- `createIgnoreFilter` can't distinguish a file from a directory for a deleted watcher-event path, so directory-only patterns (e.g. `build/`) may misfire.
- `loadGitignore`/`isIgnoredChange`/`IgnoreMatcher` are intentionally not exported — only `createIgnoreFilter(rootPath)` is, to keep the `ignore` package's default-export type out of this package's public `.d.ts`.
- `VsCodeWatchBackend` only fires renames done through VS Code itself; a terminal `mv`/`git mv` arrives as `'deleted'`+`'created'` instead.
