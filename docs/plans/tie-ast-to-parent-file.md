# Tie generated ASTs to their parent file

## Context

**Where this code lives.** Branch `discovery` in the main checkout,
`/Users/brianhenson/projects/foss/cpg-me-daddy`. This plan was written from a session
locked to the `cpg-research-sweep` worktree, which is a *different lineage* (it has
`engine`/`cli`/`falkordb-service`/`vscode`, not `ast-generator`/`file-watcher`). Execute
this from the main checkout on `discovery`.

**The problem.** AST generation works, but the artifact it produces is not reliably
connected to the file it came from. Tracing the flow —
`extension.ts:35` → `WorkspaceSession.start()` (`workspaceSession.ts:38`) →
`parseWorkspace` (walk only, no AST) → `monitorWorkspace` → `ChangeBatcher` → `applyOne`
→ `maybeDumpAst` (`monitor.ts:126`) → `dumpAst` — the link breaks in six places:

1. **Basename-only output path.** `ast-generator/src/index.ts:108` writes
   `${basename(filePath)}.ast.json`. In this repo alone, five `packages/*/src/index.ts`
   files collapse into one `out/ast/index.ts.ast.json`. Last writer wins, silently. This
   is the core defect.
2. **No shared identity.** Graph nodes key on the **absolute** path
   (`toGraphPayload`, `file-watcher/src/index.ts:136`); artifacts key on **basename**.
   Nothing joins them. `ParsedFile.filePath` is just the string the caller happened to pass.
3. **No content identity.** `ParsedFile` carries no hash/size/mtime, so you cannot tell
   whether an artifact matches the file's current bytes.
4. **Arbitrary coverage.** `parseWorkspace` never parses; only post-activation *changes*
   dump. `out/ast/` is a sparse subset of whatever you happened to touch.
5. **Orphans on delete/move** — acknowledged as future work at `monitor.ts:92-94`.
6. **Fire-and-forget races.** `maybeDumpAst` isn't awaited; two fast saves can land out
   of order, leaving the older AST on disk.

**Outcome.** One explicit `SourceFileId` shared by both packages; an in-memory `AstIndex`
keyed by that id as the authoritative tie; a collision-free `out/ast/` mirror as an
opt-in debug artifact; complete coverage from a cancellable full-workspace parse; and
delete/move upkeep so the index and mirror stay truthful.

**Two useful facts confirmed while exploring:**
- `out` is in `DEFAULT_IGNORED_DIRECTORIES`, so writing under `out/ast/` cannot feed back
  into the watcher. No loop risk.
- `GraphNode.data?: Record<string, unknown>` already exists in
  `graph-visualizer/src/contract.ts`. Annotating file nodes with AST state needs **no
  contract change**.

---

## Design

Layering stays as it is: `ast-generator` is a leaf with no `@cpg/*` dependencies, and
`file-watcher` depends on it. **`ast-generator` must not learn workspace semantics** —
it is told an identity, it does not compute one from a root it owns. The one exception is
a pure path-math helper (below), which keeps the POSIX-normalisation rule in a single place.

Follows the repo's existing precedent of a zero-import `contract.ts`
(`graph-visualizer/src/contract.ts`, `file-watcher/src/changes.ts`).

---

## 1. `packages/ast-generator/src/contract.ts` — new, zero imports

```ts
/** Identity of a parsed source file. `relPath` is the canonical join key. */
export interface SourceFileId {
  /** Workspace-relative, POSIX-separated: 'packages/ast-generator/src/index.ts'. */
  relPath: string;
  /** Absolute path on this machine. For opening the file; not portable. */
  absPath: string;
}

/** What we know about a file's AST without holding the tree. */
export interface AstRecord {
  id: SourceFileId;
  grammar: string;
  /** sha256 of the file's bytes at parse time — the staleness check. */
  contentHash: string;
  size: number;
  mtimeMs: number;
  parsedAt: number;
  /** Where the debug mirror was written, when dumping is on. */
  artifactPath?: string;
}

export interface AstNode { /* moved verbatim from index.ts */ }

export interface ParsedFile extends AstRecord {
  root: AstNode;
  sExpression: string;
}
```

`ParsedFile` replaces today's `filePath: string` with `id` plus the content fields. This
changes the on-disk JSON shape; `dumpAst` is the only producer and there are no persisted
artifacts to migrate (`out/ast/` does not currently exist).

## 2. `packages/ast-generator/src/index.ts` — rework

**Identity helper** (pure path math, no workspace semantics):

```ts
export function sourceFileId(rootPath: string, absPath: string): SourceFileId
// relPath = relative(rootPath, absPath).split(sep).join('/')
```

**Split parsing from writing.** Today `dumpAst` does both; that coupling is why the
output path is decided somewhere that knows nothing about the workspace.

```ts
export async function parseFile(id: SourceFileId): Promise<ParsedFile>
export function astArtifactPath(outputDir: string, relPath: string): string
export async function writeAst(parsed: ParsedFile, outputDir: string): Promise<string>
export async function removeAst(outputDir: string, relPath: string): Promise<void>
```

- `parseFile` reads + `stat`s `id.absPath`, hashes the bytes (`node:crypto`, sha256),
  and returns `ParsedFile` with `id`, `contentHash`, `size`, `mtimeMs`, `parsedAt`.
- `astArtifactPath` mirrors the tree:
  `packages/ast-generator/src/index.ts` → `<outputDir>/packages/ast-generator/src/index.ts.ast.json`.
  **Guard against escape:** reject a `relPath` that is absolute or contains a `..`
  segment, so a path outside the root can never write outside `outputDir`.
- `writeAst` does `mkdir(dirname, { recursive: true })` then writes.
- `removeAst` unlinks, ignoring ENOENT. Leave empty directories behind — pruning them is
  churn for no benefit.

**Memoise grammar loading — required, not an optimisation.** `parseFile` currently calls
`Parser.init()` *and* re-reads + recompiles the `.wasm` grammar on **every file**
(`index.ts:86-88`). That is survivable for a one-file CLI demo and ruinous the moment
step 4 parses a whole workspace. Add module-level caches:

```ts
let parserInit: Promise<void> | undefined;              // Parser.init() exactly once
const languages = new Map<string, Promise<Language>>(); // wasm basename -> Language
```

Cache the *promises*, not the resolved values, so concurrent callers share one load.

**Keep `isSupportedExtension` exactly as it is** — `monitor.ts` already depends on it and
the contract is right.

**CLI `main()`** composes the new pieces: `sourceFileId(process.cwd(), abs)` →
`parseFile` → `writeAst`. Behaviour from the outside is unchanged except that the output
path now mirrors the relative path.

## 3. `packages/file-watcher/src/ast-index.ts` — new

Two exports; this is the piece that actually *is* the tie.

**`AstIndex`** — pure state, keyed by `relPath`:

```ts
get(relPath): AstRecord | undefined
entries(): IterableIterator<[string, AstRecord]>
set(record: AstRecord): void
delete(relPath): void
/** True when a parse can be skipped: this exact contentHash is already recorded. */
isCurrent(relPath, contentHash): boolean
size: number
```

**`AstCoordinator`** — owns the index plus all async concerns:

```ts
constructor(opts: {
  rootPath: string;
  /** When set, mirror each AST to disk. Omit to keep everything in memory. */
  outputDir?: string;
  onIndexed?: (record: AstRecord) => void;
  onRemoved?: (relPath: string) => void;
  onError?: (error: Error) => void;
})

upsert(absPath: string): Promise<void>      // skips unsupported extensions
remove(absPath: string): Promise<void>
parseAll(tree: FileTreeNode, opts?: { onProgress?; token? }): Promise<void>
readonly index: AstIndex
```

Three responsibilities, each fixing one of the six defects:

- **Per-path serialisation** (fixes #6). A `Map<string, Promise<unknown>>` chains work for
  a given `relPath` so two rapid saves cannot land out of order:
  ```ts
  const prev = this.chains.get(relPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);           // run regardless of prior outcome
  this.chains.set(relPath, next.catch(() => {}));
  ```
  Delete the map entry when the settled promise is still the tail, so the map doesn't grow
  unbounded over a long session.
- **Hash gate** (fixes #3). `upsert` reads and hashes first; if `index.isCurrent`, it
  returns without parsing. VS Code fires `'changed'` on saves that don't alter bytes, so
  this elides a lot of wasted wasm work.
- **Mirror upkeep** (fixes #5). `remove` deletes the record *and* the artifact.

## 4. `packages/file-watcher/src/index.ts` — full-workspace coverage

`parseWorkspace` keeps its current job (walk → payload → index) and its signature. The
slow AST pass lives in `AstCoordinator.parseAll`, which walks the already-built
`FileTreeNode` tree rather than re-reading the filesystem:

- filters with `isSupportedExtension`;
- runs a **small bounded pool (4)** — tree-sitter wasm parsing is CPU-bound and
  single-threaded, so the pool is there to overlap file I/O, not to parallelise parsing;
- `await new Promise(setImmediate)` every N files so the extension host stays responsive;
- checks `token.isCancellationRequested` between batches and returns early;
- reports `onProgress(done, total, current)`.

`ParseWorkspaceResult` gains nothing; the session holds the `AstCoordinator`.

**Annotating the graph.** Add a helper that folds AST state into an existing payload
using the `data` field that already exists:

```ts
export function annotateWithAst(payload: GraphPayload, rootPath: string, index: AstIndex): GraphPayload
// node.data = { ...node.data, ast: { grammar, contentHash, parsedAt, artifactPath } }
```

Join by computing `relative(rootPath, node.id)` — graph ids stay absolute, so
`WorkspaceGraphIndex`, `toGraphPayload` and the visualizer are untouched.

## 5. `packages/file-watcher/src/monitor.ts` — route through the coordinator

`monitorWorkspace` already takes seven positional parameters. Collapse the optional tail
into an options object (one caller to update):

```ts
export interface MonitorWorkspaceOptions {
  ast?: AstCoordinator;
  onDelta?: GraphDeltaListener;
  onError?: FileWatcherErrorListener;
  onAstTrigger?: AstTriggerListener;
}
export function monitorWorkspace(rootPath, index, backend, options?): WatchSubscription
```

`maybeDumpAst` is deleted. `applyOne` routes instead:

| kind | AST action | index action |
| --- | --- | --- |
| `created` | `ast.upsert(path)` | `applyChange` |
| `changed` | `ast.upsert(path)` | — |
| `deleted` | `ast.remove(path)` | `applyChange` |
| `moved` | `ast.remove(fromPath)` **+** `ast.upsert(path)` | `applyMove` |

The `moved` row is the fix for #5: today a rename writes a fresh dump under the new
basename and abandons the old one.

`onAstDump` is superseded by the coordinator's `onIndexed`/`onRemoved`, which carry the
full `AstRecord` rather than two bare strings. Keep `onAstTrigger` as-is — it is a useful
trace signal and its contract is already accurate.

## 6. `src/workspaceSession.ts` — ordering

```ts
async start(): Promise<GraphPayload> {
  const { tree, payload, index, nodeCount } = await parseWorkspace(this.rootPath);
  this.log(`indexed ${this.rootPath} (${nodeCount} nodes)`);

  this.ast = new AstCoordinator({ rootPath: this.rootPath, outputDir: this.astOutputDir, ... });
  this.subscription = monitorWorkspace(this.rootPath, index, this.backend, { ast: this.ast, ... });

  // Background: presence graph paints now, AST fills in behind it.
  void this.ast.parseAll(tree, { onProgress, token: this.cts.token })
    .then(() => this.log(`ast: ${this.ast.index.size} files parsed`))
    .catch((e) => this.onError(...));

  return payload;
}
```

Also add a `vscode.CancellationTokenSource` cancelled in `dispose()`, so closing the
folder stops an in-flight parse.

**A deliberate departure from the sketch in the question.** I am *not* wrapping the AST
pass in `queue.pause()`/`resume()`. The walk is still synchronous, so the
`WorkspaceGraphIndex` is fully built before the watcher subscribes — there is no
mid-parse presence race to buffer. Pausing would only delay legitimate create/delete
deltas behind a multi-second parse. The real race the AST pass introduces is *content*
ordering (the pass and a concurrent save both parsing one file), and the per-path chain
plus hash gate in step 3 is the correct, finer-grained answer to it. `pause()`/`resume()`
stay available, unused, for when the **walk itself** goes async — which is the migration
the comments in `queue.ts` and `workspaceSession.ts` were actually anticipating.

## 7. `package.json` — opt-in dump

No `contributes.configuration` block exists yet; add one:

```jsonc
"cpgMeDaddy.ast.dumpToDisk": {
  "type": "boolean",
  "default": false,
  "description": "Write each parsed AST to out/ast/, mirroring the workspace tree. Debugging aid; the in-memory index is authoritative."
}
```

`extension.ts` reads it and passes `outputDir` (or `undefined`) into `WorkspaceSession`.
Default `false` keeps activation cheap and stops a large workspace spraying thousands of
JSON files on first open.

---

## Files touched

| File | Change |
| --- | --- |
| `packages/ast-generator/src/contract.ts` | **new** — `SourceFileId`, `AstRecord`, `AstNode`, `ParsedFile` |
| `packages/ast-generator/src/index.ts` | `sourceFileId`, split `parseFile`/`writeAst`/`removeAst`/`astArtifactPath`, memoise grammars |
| `packages/file-watcher/src/ast-index.ts` | **new** — `AstIndex`, `AstCoordinator` |
| `packages/file-watcher/src/index.ts` | `AstCoordinator.parseAll` support, `annotateWithAst`, re-export `./ast-index` |
| `packages/file-watcher/src/monitor.ts` | options object; delete `maybeDumpAst`; route created/changed/deleted/moved |
| `src/workspaceSession.ts` | own the coordinator, subscribe-then-parse ordering, cancellation |
| `src/extension.ts` | read the setting, pass `outputDir` through |
| `package.json` | `contributes.configuration` |
| `packages/*/AGENTS.md`, `CLAUDE.md` | update the status/API prose — these files are unusually detailed here and will otherwise go stale immediately |

**No tsconfig changes needed** — `file-watcher/tsconfig.json` already references
`../ast-generator`, and the root already references both.

**No `graph-visualizer` changes** — `GraphNode.data` covers annotation.

---

## Verification

There is no test runner in this repo (`file-watcher/AGENTS.md`: *"verified ad hoc during
development"*), so this is a build + manual + scripted check.

**1. Build**
```
npm run compile
```

**2. Collision regression — the original defect.** From the repo root, with a scratch
script or `node -e`, parse two same-basename files and confirm two distinct artifacts:
```
packages/ast-generator/src/index.ts  -> out/ast/packages/ast-generator/src/index.ts.ast.json
packages/file-watcher/src/index.ts   -> out/ast/packages/file-watcher/src/index.ts.ast.json
```
Before this change both resolve to `out/ast/index.ts.ast.json`. This is the single most
important assertion in the plan.

**3. Headless coordinator test.** `monitorWorkspace` takes a `WatchBackend`, and
`ChangeBatcher` accepts an injected clock, so no extension host is needed. Drive a fake
backend against a temp directory and assert:
- `created` → record present, `contentHash` matches sha256 of the bytes on disk;
- `changed` with **identical** bytes → no re-parse (hash gate; check `parsedAt` is unchanged);
- `changed` with new bytes → `contentHash` updates;
- `deleted` → record gone **and** mirrored artifact unlinked;
- `moved` → old `relPath` and its artifact gone, new one present;
- two `changed` events fired back-to-back → final artifact matches the **final** content
  (the per-path ordering fix).

**4. Path-escape guard.** `astArtifactPath(outputDir, '../../etc/passwd')` must throw.

**5. In the extension (F5, "Run Extension").** Open a multi-package workspace:
- activation logs the walk immediately — first paint is **not** blocked by the AST pass;
- the AST progress log then counts up and settles at the supported-file count;
- with `cpgMeDaddy.ast.dumpToDisk: true`, `out/ast/` mirrors the tree with no collisions;
- editing a file updates only that file's record;
- closing the folder mid-parse cancels it (no further progress logs).

**6. No feedback loop.** With dumping on, confirm writes under `out/ast/` produce no
further watcher events — `out` is in `DEFAULT_IGNORED_DIRECTORIES`, so this should hold;
worth confirming once explicitly, since a regression here would be an infinite parse loop.

---

## Deferred (called out, not in scope)

- **Live AST annotation in the webview.** `applyGraphDelta` *concatenates* `addedNodes`,
  so re-emitting an existing node id would duplicate it rather than update it. Annotating
  a node after its initial paint needs a new `updatedNodes` field on `GraphDelta` — a real
  contract change in `graph-visualizer`. Until then, annotation applies to the initial
  payload (via `annotateWithAst`) and to the host's snapshot copy, which the webview picks
  up on reconnect.
- **Persisting the index across restarts** (an `out/ast/manifest.json`, or moving graph
  node ids to workspace-relative paths for portability). Absolute-path ids are fine
  in-process; they are the wrong key for anything durable.
- **`applyMove` position preservation** — the pre-existing `SEAT` at
  `file-watcher/src/index.ts:214`, untouched here.
- **Wiring `cpg-generator` / `graph-builder`.** Still `hello()` stubs. The `AstIndex` is
  deliberately shaped to be what `toSubgraph` consumes when they come online.
