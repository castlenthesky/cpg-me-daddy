# @cpg/graph-builder

Status: tracks which AST node ids are currently on screen per file, so a re-parse or deletion
produces exactly the `GraphDelta` needed to bring that file's rendered subgraph up to date.

## API (`src/index.ts`)

- `GraphBuilder` — one instance per workspace (constructed by `WorkspaceSession` and passed into `monitorWorkspace`'s `builder` option). Holds `Map<filePath, nodeId[]>`.
  - `replaceFile(filePath, subgraph): GraphDelta` — removes the ids this file previously contributed (empty on first parse) and adds the new subgraph's, in one delta.
  - `removeFile(filePath): GraphDelta | undefined` — removes one file's AST nodes outright; `undefined` if nothing was tracked for it.
  - `removeUnder(removedIds): string[]` — sweeps every tracked file whose path is, or falls under, one of `removedIds` (a whole-directory delete/move). Called by `@cpg/file-watcher`'s `monitor.ts` against a presence delta's `removedNodeIds` before it's forwarded, since that delta only names the removed file/directory node itself, never the AST ids hanging off it.
  - `isIndexed(filePath): boolean` — `REAL`. Whether this file was parsed into the graph at all, which is what separates "there is no definition there" (`unresolved`) from "we never looked" (`external`). True even for a file that yielded no nodes, since `replaceFile` registers empties.
  - `symbolAt(filePath, row, column)` / `symbolNamed(filePath, name)` / `hasSymbol(fqn)` — the reverse of `data.location`: given where a resolver says a definition is, which *symbol* is that? Returns the fqn, not an AST node id, because an AST id is positional and would change on the defining file's next re-parse. `symbolAt` hits on the definition's name-token start (what `textDocument/definition` and `LocationLink.targetSelectionRange` report), then falls back to the most tightly enclosing definition extent. Together with `isIndexed` these satisfy `@cpg/cpg-generator`'s `DefinitionLookup` **structurally**, so this package still imports nothing but the render contract.
  - `syncSymbols` (private) — reference-counted symbol lifetime. Newly-defined fqns are added (emitted only if no other file already defines them); no-longer-defined fqns are removed only once their **last definer** is gone; an fqn present before *and* after is left strictly alone, not re-added, so it keeps its visualizer index, position, and every inbound edge from every other file. That last case is what makes a save of the defining file invisible to its callers.

## Gotchas

- Depends only on `@cpg/graph-visualizer`'s contract types (`GraphNode`/`GraphEdge`/`GraphDelta`) — nothing from `@cpg/cpg-generator`, so the reference graph stays a chain.
- **`CpgSubgraphLike.symbols` is a separate channel from `nodes`, and that separation is load-bearing.** `idsByFile` is built from `nodes` alone, so a `SYMBOL` listed there would be *owned* by that file — and the next `replaceFile` would name it in `removedNodeIds`, which makes `applyGraphDelta` drop every edge touching it, including *another* file's `CALLS` edge, permanently, with nothing to re-add it. Keeping symbols out of `nodes` means no file can own one, so no code path can sweep one. There is no `removedEdgeIds` in `GraphDelta` to repair it with.
- `replaceFile` puts symbol nodes **after** the AST nodes in `addedNodes`. `applyDeltaInternal` seeds a new node's position from its parent's via an index it builds while walking that array, so a symbol ahead of its defining `METHOD` would seed at the space centre instead of beside its definition.
- Not thread-safe / not reentrant across concurrent calls for the same file — `@cpg/file-watcher`'s `AstPipeline` serializes per-path calls so this never needs to be.
