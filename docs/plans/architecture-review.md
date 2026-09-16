# Architectural review: structuring for collaboration and independent evolution

Written 2026-09-15 against branch `discovery`. Scope is **structure**, not defects — known
bugs and unimplemented features are deliberately out of scope. The question answered here is
the one asked: *how do we structure this code so several people can work in it, so the pieces
decouple cleanly, and so the extension becomes a thin interface over a self-contained system?*

---

## Verdict up front

The seam *craft* in this repo is genuinely good. `WatchBackend` and `Resolver` are textbook:
zero-import, declared by the consumer, implemented in the host, fakeable without VS Code, and
each carries a comment explaining *why* the seam exists rather than just what it does. That is
a higher standard than most codebases hold.

The problem is not seam quality. It is **seam placement**. Three structural facts work against
the stated vision:

1. **The type vocabulary lives inside the renderer.** Every Node-side package depends on
   `@cpg/graph-visualizer` — the DOM/WebGL package — to know what a node is.
2. **`@cpg/file-watcher` is not a file watcher.** It is the entire engine, and it imports all
   four of its downstream consumers by name.
3. **There is no composition root outside the extension.** `src/workspaceSession.ts` is the
   only place the pipeline is assembled, so "run this without VS Code" required a 442-line
   hand-rolled duplicate (`src/dev/resolveHarness.ts`).

All three have the same root cause and largely the same fix. None of them require redesigning
the data model — the types are already domain-neutral and well-shaped. This is mostly a
**relocation** problem, which is the cheap kind.

---

## 1. Where the dependencies actually point

### Today

```
                       ┌──────────────────────────┐
                       │    graph-visualizer      │
                       │  DOM · WebGL · cosmos.gl │
                       │  ──────────────────────  │
                       │   contract.ts  ◀── the   │
                       │   whole project's        │
                       │   vocabulary lives here  │
                       └────────────▲─────────────┘
                                    │  deep-imported as `/dist/contract`
        ┌───────────────┬───────────┼────────────┬──────────────────┐
        │               │           │            │                  │
  ast-generator   cpg-generator  graph-builder   │           src/ (ext host)
        ▲               ▲           ▲            │
        │               │           │            │
        └───────────────┴───────────┴────────────┘
                     @cpg/file-watcher
              (imports all three, by name)
```

`@cpg/file-watcher`'s `package.json` lists `ast-generator`, `cpg-generator`, `graph-builder`
and `graph-visualizer` as dependencies. That is the literal inverse of the stated goal —
"the file-watcher should not need to know about the downstream consumers."

### Where it should point

Every arrow toward a single zero-dependency vocabulary package; nothing depends on anything
that renders:

```
                         ┌───────────────┐
                         │   cpg-model   │   zero deps, zero DOM
                         │  vocabulary + │   the only thing everyone shares
                         │  event types  │
                         └───────▲───────┘
         ┌──────────┬──────────┬─┴────────┬───────────┬──────────────┐
         │          │          │          │           │              │
      watch    workspace-  ast-gen    cpg-gen    graph-store   graph-visualizer
                 scan
         ▲          ▲          ▲          ▲           ▲
         └──────────┴──────────┴──────────┴───────────┘
                               │
                         ┌─────┴──────┐
                         │   engine   │   owns phase order + lifecycle
                         └──▲──────▲──┘
                            │      │
                          cli    src/ (VS Code adapters only)
```

---

## 2. The vocabulary lives in the renderer

`packages/graph-visualizer/src/contract.ts` defines `SourceRange`, `NodeLocation`, `GraphNode`,
`GraphEdge`, `GraphPayload`, `GraphDelta`, `EdgeResolution`, plus the `nodeLocation` /
`edgeResolution` / `applyGraphDelta` accessors. That is the project's core data model, and it
sits inside the browser-targeted, `@cosmos.gl/graph`-dependent, DOM-lib package.

**None of these types are render types.** `GraphNode` is `{ id, type: string, name?, data? }`.
There is nothing about drawing in it. It is a domain type that happens to live in the wrong
building.

### What that costs today, in the code

Every consumer must bypass the package's public entry point:

```ts
import type { GraphDelta, GraphPayload } from '@cpg/graph-visualizer/dist/contract';
```

…and each site carries a paragraph explaining why. Four separate copies of that explanation
exist (`file-watcher/src/index.ts:5-12`, `graph-builder/src/index.ts:2-4`,
`cpg-generator/src/refSites.ts:2-6`, `src/workspaceSession.ts:5-7`), plus supporting rules in
two `AGENTS.md` files:

> `contract.ts` and `shell.ts` must stay import-free — the CommonJS extension host
> deep-imports `dist/contract`/`dist/shell` instead of the ESM-only main entry.

Three concrete consequences:

- **The build can't enforce the rule.** "Keep `contract.ts` import-free" is enforced by comment
  and code review. One `import` added to that file breaks the extension host at runtime, and
  nothing catches it.
- **`dist/` is the public API.** Deep-importing compiled output couples every consumer to the
  emit layout. There is no `exports` map, so "what is public" is "whatever files land in
  `dist/`". `src/dev/resolveHarness.ts:8` already reaches into
  `@cpg/graph-visualizer/dist/layout` for `DEFAULT_FALLBACK_PARENT_EDGE_TYPES`.
- **New contributors will get it wrong.** The natural import is the barrel. The barrel is the
  wrong answer, and the failure mode (DOM lib errors in a Node package) is confusing rather
  than obvious.

### The fix

Create `@cpg/cpg-model`: zero dependencies, zero DOM, `"types": []`. Move `contract.ts` into it
verbatim. `graph-visualizer` re-exports from it for the webview's convenience and becomes an
ordinary consumer.

This deletes every deep import, deletes ~40 lines of explanatory comment, turns a
comment-enforced rule into a structural one (a package with no dependencies cannot acquire a
DOM dependency by accident), and gives `graph-visualizer` a normal `exports` map again.

**It is close to a pure file move.** The types need no redesign. Highest value-per-byte change
available, and it unblocks most of what follows.

### The one real bidirectional coupling to fix alongside it

Producers mint label strings the renderer must already know about:

- `file-watcher`'s `toGraphPayload` emits `'CONTAINS'` because `layoutPayload` seeds its radial
  layout from that exact type.
- `graph-builder` exports `SYMBOL_NODE_TYPE = 'SYMBOL'`, documented as *"Registered in
  `@cpg/graph-visualizer`'s `NODE_TYPES` for its colour and legend row."*
- `layout.ts`'s `DEFAULT_FALLBACK_PARENT_EDGE_TYPES = ['DEFINES']` exists specifically to place
  `SYMBOL` nodes that producers emit.

So adding a node type today means editing the renderer. That is a cross-team edit for what
should be a producer-local change.

`relationshipTypes.ts` already solves this correctly and should be the model: it derives legend
rows from whatever edge types are actually present in the payload and falls back to the raw
type string with a neutral swatch for anything it doesn't recognise. `nodeTypes.ts` is
exhaustive by contrast. **Make `NODE_TYPES` derive-and-fallback like `RELATIONSHIP_TYPES`.**
Then the domain label registry lives in `cpg-model`, presentation stays in the visualizer keyed
off it, and a new node type renders (in grey, with its raw label) without anyone touching the
renderer.

---

## 3. `@cpg/file-watcher` is the engine wearing a watcher's name

The package contains, in ~1,300 lines:

| Concern | Where | Actually a watcher concern? |
|---|---|---|
| `WatchBackend`, `WorkspaceChange`, `ChangeKind` | `changes.ts` | **Yes** — and it's perfect: 46 lines, zero imports |
| `ChangeBatcher` (debounce/dedupe) | `debounce.ts` | **Yes** |
| `walkWorkspace`, `.gitignore` handling | `index.ts` | Workspace scanning |
| `WorkspaceGraphIndex` | `index.ts` | Graph state |
| `toGraphPayload` | `index.ts` | Projection into render vocabulary |
| `parseWorkspace` (walk → AST → resolve) | `index.ts` | **Orchestration** |
| `runAstPass` | `astPass.ts` | Pipeline stage |
| `runResolvePass` | `resolvePass.ts` | Pipeline stage |
| `AstPipeline` | `astPipeline.ts` | Pipeline stage |
| `UpdateQueue` | `queue.ts` | Transport |

The genuine file-watcher is already isolated and already correct — `changes.ts` is zero-import
and backend-agnostic. It is 46 lines buried inside a package that also runs tree-sitter.

Two signals that `index.ts` in particular is overloaded:

- It is both the barrel *and* an implementation module, which forces three deliberate import
  cycles (`index` ↔ `astPass`, `index` ↔ `resolvePass`, `monitor` ↔ `astPipeline`). Each is
  erased because it's type-only, and each carries a comment explaining that. Working as
  intended, but three modules needing that comment is the diagnostic.
- `parseWorkspace` returns a `GraphPayload` — the render shape — because the webview is the
  presumed destination.

### The fix: split along the seams that already exist

- **`@cpg/watch`** — `changes.ts` + `debounce.ts` + the delivery machinery. Depends on
  `cpg-model` only (for event types). Emits change batches. Knows nothing downstream. ~250
  lines.
- **`@cpg/workspace-scan`** — `walkWorkspace`, ignore handling, `WorkspaceGraphIndex`.
- **`@cpg/engine`** — `parseWorkspace`, `runAstPass`, `runResolvePass`, `AstPipeline`, phase
  ordering. This is the orchestrator, and it is the package that is *allowed* to know about
  `ast-generator`, `cpg-generator` and `graph-store`.

The rename matters for collaboration: a package named `file-watcher` that owns the AST pass is
a package no one can reason about from its name, and two people editing "the watcher" are
editing unrelated things.

---

## 4. The composition root is trapped inside the extension

`src/workspaceSession.ts` is 120 lines of real orchestration: resolver lifecycle (`open`),
phase ordering (parse → monitor), shared-instance invariants (one `GraphBuilder`, one
`Resolver` across both phases), and progress reporting. **None of it is VS Code-specific.**
It imports `vscode` nowhere. But it lives in `src/`, so only the extension can reach it.

The cost is already paid and visible: `src/dev/resolveHarness.ts` is **442 lines** — three and
a half times the size of the thing it exists to exercise — hand-rolling the same wiring so the
pipeline can run under plain `node`. Its own doc comment says:

> Drives the real pipeline over a real workspace with everything except `vscode` […] There is
> no test runner in this repo; it is a plain script, run by hand.

A 442-line harness reimplementing a 120-line session class is the clearest possible signal that
the composition root is in the wrong package. It also hardcodes
`/Users/brianhenson/projects/demos/ast-demo` as its default workspace, so it is one developer's
script rather than a team asset.

### The fix

Move `WorkspaceSession` into `@cpg/engine` and give it a config object instead of six
positional constructor parameters:

```ts
export interface EngineConfig {
  rootPath: string;
  watch: WatchBackend;      // adapter, injected
  resolver: Resolver;       // adapter, injected
  sinks: GraphSink[];       // outputs, injected  (see §5)
  events?: EventSink;       // structured events  (see §5)
  limits?: { maxAstNodes?: number };
}

export function createEngine(config: EngineConfig): Engine;
// Engine: { start(): Promise<void>; stop(): Promise<void> }
```

Then:

- **`src/extension.ts`** becomes: construct `VsCodeWatchBackend` + `VsCodeDefinitionResolver` +
  a webview sink, call `createEngine`, done. That is the stated vision — the extension is an
  interface over a self-contained system.
- **`packages/cli`** becomes a real `bin` over the same `createEngine`, with `NodeWatchBackend`
  and whatever resolver is available headlessly. `resolveHarness.ts` collapses into a fixture
  plus a handful of assertions.
- **The daemon** described in `docs/architecture/service-boundaries.md` (`.cpg/engine.json`,
  unix socket, attach-or-spawn) becomes a third front-end over the same core rather than a
  rewrite.

---

## 5. Two excellent seams; three missing ones

`WatchBackend` and `Resolver` share a pattern worth naming explicitly, because it is the thing
to replicate:

> **Zero-import interface, declared by the consumer, implemented by the host, substitutable by
> a fake.**

`resolve.ts`'s own comment articulates the payoff better than I could:

> the hard part — turning a definition location into a stable symbol identity — can be driven
> by a fake resolver in a throwaway `node` script with no VS Code running at all.

That discipline is applied to **inputs**. It is applied to no **output**. Three seams are
missing, and each one is a place a second contributor currently cannot work independently.

### 5a. Missing: an output seam (`GraphSink`)

There is no counterpart to `WatchBackend` on the way out. `parseWorkspace` *returns* a
`GraphPayload`; `monitorWorkspace` takes an `onDelta` callback. The producer therefore assumes
exactly one consumer, in-process, that wants the render shape.

This blocks, concretely: the FalkorDB store (already researched, already in the MCP config, with
benchmarks in `.agent/knowledge/planning-sessions/`), the MCP server (`30-mcp-server.yaml`), a
JSON-lines dump for golden tests, and the CLI.

Mirror the input seam:

```ts
export interface GraphSink {
  onSnapshot(graph: CpgGraph, meta: SnapshotMeta): Promise<void>;
  onDelta(delta: GraphDelta, meta: DeltaMeta): Promise<void>;
}
```

`meta` carries `seq` and `cause` — the previous lineage already designed this
(`docs/architecture/service-boundaries.md`), including at-least-once delivery, serialization,
and bounded retry. **Async and `Promise`-returning from day one**, because it is the seam a
process boundary eventually lands on, and retrofitting async through a synchronous callback
chain is the expensive version of this change.

Then: the webview bridge is a sink, FalkorDB is a sink, the MCP server is a sink, a test
recorder is a sink. The engine knows none of them. That is the user's requirement stated
precisely.

### 5b. Missing: a structured event seam

Diagnostics currently travel as **eight** distinct listener types plus a bare `log` function:

`AstPassProgressListener`, `AstPassErrorListener`, `ResolvePassProgressListener`,
`ResolvePassErrorListener`, `GraphDeltaListener`, `FileWatcherErrorListener`,
`AstDumpListener`, `AstTriggerListener` — and
`log: (message: string) => void` threaded through `WorkspaceSession`'s constructor.

Two problems beyond the obvious surface-area one:

- **The engine makes presentation decisions.** `WorkspaceSession.start()` calls `relative()`,
  interpolates strings, and applies a `PARSE_LOG_INTERVAL = 25` throttle — because the Insights
  panel has a 200-entry cap. That is a UI constraint encoded in orchestration logic. A CLI
  wanting a progress bar, or a test wanting counts, has to re-derive them from prose.
- **Strings don't cross a process boundary usefully**, and the daemon is on the roadmap.

Replace all ten with one serializable union:

```ts
export type EngineEvent =
  | { kind: 'phase';    phase: Phase; state: 'start' | 'end'; stats?: PhaseStats }
  | { kind: 'progress'; phase: Phase; done: number; total: number; path?: string }
  | { kind: 'file-error'; phase: Phase; path: string; error: SerializedError }
  | { kind: 'degraded'; paths: string[]; reason: string };

export interface EventSink { emit(event: EngineEvent): void; }
```

The host decides throttling and formatting. The extension throttles for its capped panel; the
CLI renders a progress bar; a test asserts on counts. One seam, three presentations, no
coordination.

### 5c. Missing: a storage seam

The graph lives in `GraphBuilder`'s in-memory `Map`s and is handed wholesale to a webview.
There is no interface where a store plugs in — so the FalkorDB work, which has already been
researched and benchmarked, has nowhere to attach without editing the pipeline.

The previous lineage had `IGraphStore` and it is described in detail in
`docs/architecture/service-boundaries.md`. Re-introduce it as the sink implementation above
rather than as a new concept.

---

## 6. `GraphBuilder` does three jobs on three different clocks

`packages/graph-builder/src/index.ts` (335 lines) owns:

1. **Per-file AST node lifecycle** — `idsByFile`, `replaceFile`, `removeUnder`. Clock: one file
   re-parse.
2. **Symbol lifetime** — `symbolsByFile`, `filesBySymbol`, `symbolNodes`, `syncSymbols`.
   Deliberately a *different* rule (a symbol outlives the file that defines it, so cross-file
   edges survive), and the comments correctly flag this as the load-bearing invariant.
3. **The definition index** — `definitionsByFile`, `symbolAt` / `symbolNamed` / `hasSymbol` /
   `isIndexed`, satisfying `DefinitionLookup`. Clock: resolver queries.

These are three coherent components sharing a class. For collaboration that matters: symbol
identity is the subtlest thing in the codebase, and it is currently interleaved with routine
id bookkeeping in the same file.

Split into `FileNodeRegistry`, `SymbolRegistry`, `DefinitionIndex`, composed by a thin
`GraphBuilder` façade. Same behaviour, three testable units, and the invariant that matters
gets its own file with its own doc.

**One related note.** `DefinitionLookup` is satisfied *structurally* — `cpg-generator` declares
the interface, `GraphBuilder` happens to match, neither imports the other. The comment
explaining this is good and the layering intent is right. But the coupling is real and
invisible to the compiler: rename a method on `GraphBuilder` and the build fails at the call
sites in `cpg-generator`'s consumers, not at either definition. Once `cpg-model` exists, move
`DefinitionLookup` there and have `GraphBuilder` declare `implements DefinitionLookup`. Same
layering, now checked.

---

## 7. The architecture doc describes a codebase that no longer exists

`docs/architecture/service-boundaries.md` is the best design document in the repo. It specifies
the `WatchSink` seam, `ChangeBatch` with `seq` and `cause`, at-least-once delivery, `SerialQueue`
serialization, `withRetry` backoff, `onDegraded` reporting, and the rule that the watcher's
known-state only advances on confirmed delivery. It even states the enforcement mechanism:

> `grep -r '"\.\./store' packages/engine/src/watch` finds nothing, and that's enforced by this
> document, not the type checker — keep it that way in review.

**Every path in it is wrong.** It describes `packages/engine/src/watch/`,
`packages/engine/src/indexer/filesystem-projector.ts`, `packages/engine/src/store/store.ts`,
`packages/vscode/src/extension.ts`. None exist on `discovery`. The rebuild
(`4cbf180 chore(repo): rebuild extension scaffold for redo first slice`) produced
`ast-generator`/`file-watcher`/`graph-builder`, and the design did not come with it.

This is actively hazardous — it is authoritative in tone, correct in substance, and unfollowable
in specifics. A new contributor reading it will look for files that aren't there.

It is also the answer to most of this review. The delivery contract §5a asks for is already
specified in it, in more detail than I've written here.

**Action:** rewrite it against the target layout below and keep it as the contract document.
Do not delete it — the thinking is sound and was expensively acquired.

---

## 8. Developer-experience and tooling

Grouped roughly by impact.

### No test runner — the single biggest collaboration blocker

Stated plainly in `src/AGENTS.md`: *"There is no test runner in this repo; this is the gate"*
(referring to `npm run verify:resolve`).

This repo has built excellent seams **for the express purpose of being testable** —
`WatchBackend` takes a fake, `ChangeBatcher` takes an injected clock, `Resolver` has a
`FixtureResolver` — and then tests none of them. The infrastructure is entirely in place; only
the runner is missing.

For a team, this is the difference between "I can change `GraphBuilder` confidently" and "I
must ask Brian." Add `vitest` (or `node --test`; either is fine — the seams don't care) and
port `resolveHarness.ts`'s assertions as the first suite. Everything else on this list is
optional by comparison.

### `ast-generator` cannot run outside this monorepo

```ts
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, 'out', 'ast');
```

A library computing a path relative to the monorepo root breaks the moment it is consumed from
anywhere else — which is precisely the "packages live independently of the extension" goal.
Output directory should be a required parameter, or default relative to `process.cwd()`.

### Debug artifact writing sits in the live hot path

`AstPipeline.runOnce` writes AST JSON to disk on every save, before building the delta, and
`dumpAstToDisk` **defaults to `true`**. Debug output should be a `GraphSink` subscriber, not a
pipeline stage — then it costs nothing when nobody's watching and can't fail a parse.

### Compiled output committed inside `src/`

Six tracked files that should not exist:

```
packages/cpg-generator/src/index.js      packages/cpg-generator/src/index.js.map
packages/file-watcher/src/index.js       packages/file-watcher/src/index.js.map
packages/graph-builder/src/index.js      packages/graph-builder/src/index.js.map
```

`.gitignore` covers `packages/*/dist` but not stray emit inside `src/`. Delete them, and add
`packages/*/src/**/*.js` to `.gitignore`. Also untracked:
`packages/cpg-generator/python/__pycache__/`.

### Two sources of truth for the package list

`package.json` hardcodes:

```
"compile:packages": "tsc -b packages/ast-generator packages/cpg-generator packages/file-watcher packages/graph-builder packages/graph-visualizer"
```

…while `packages/AGENTS.md` states *"New packages are picked up by `package.json`'s
`workspaces` glob automatically."* Both are true about different things, and the combination
reads as "adding a package is free" when it requires edits in three files (`workspaces` is
globbed, but `compile:packages`, the root `references`, and the consumer's `references` are
not).

A single root `tsconfig.solution.json` listing every project once, with `compile:packages`
reduced to `tsc -b tsconfig.solution.json`, removes one of the three.

### Consumers resolve `dist/`, so editing `src/` does nothing

Documented as a gotcha; it is a real papercut in a watch-mode workflow. Fixable with an
`exports` map plus a `customConditions` entry pointing at source for in-workspace resolution.

### No linter, no formatter, no CI

`.github/` does not exist. Per project memory, Bun + oxlint + lefthook were tried and reverted
to npm + tsc. That's a reasonable call for a solo discovery branch; it is not one for a team.
Minimum viable: a CI job running `npm run compile` plus the new test suite on PRs. That alone
catches the deep-import and contract-purity classes of breakage that comments currently guard.

### Not a problem

`CLAUDE.md` files are symlinks to their sibling `AGENTS.md` — no duplication. Good.

---

## 9. Target package layout

```
packages/
  cpg-model/          Zero deps, zero DOM. SourceRange, NodeLocation, CpgNode,
                      CpgEdge, CpgGraph, GraphDelta, resolution vocabulary,
                      DefinitionLookup, EngineEvent, GraphSink, node/edge label
                      registry. The only package everyone may depend on.

  watch/              WatchBackend, WorkspaceChange, ChangeBatcher, delivery
                      (serialize + retry + degraded reporting). ← cpg-model

  workspace-scan/     walkWorkspace, ignore handling, WorkspaceGraphIndex.
                      ← cpg-model

  ast-generator/      tree-sitter parse → ParsedFile. No REPO_ROOT.
                      ← cpg-model

  cpg-generator/      toSubgraph, fqn, imports, refSites, Resolver seam,
                      NullResolver/ChainResolver/PythonPathResolver.
                      ← cpg-model, ast-generator

  graph-store/        FileNodeRegistry + SymbolRegistry + DefinitionIndex
                      (today's GraphBuilder, split). ← cpg-model

  engine/             THE ORCHESTRATOR. Phase ordering, passes, session
                      lifecycle, createEngine(config). The only package that
                      knows the others exist.
                      ← all of the above

  cli/                Thin bin over engine. Replaces src/dev/resolveHarness.ts.
                      ← engine

  graph-visualizer/   Rendering only. Projects CpgGraph → view model.
                      ← cpg-model

src/                  VS Code ADAPTERS ONLY:
                        watch/vscodeWatchBackend.ts     (WatchBackend impl)
                        resolve/vscodeDefinitionResolver.ts (Resolver impl)
                        sinks/webviewSink.ts            (GraphSink impl)
                        views/*                         (UI)
                        webview/graphApp.ts             (webview glue)
                        extension.ts                    (composition: ~40 lines)
```

The load-bearing rule, stated so it can be enforced:

> **No package may depend on a package that renders, stores, or hosts.**
> Arrows point toward `cpg-model`. `engine` is the only package permitted to know more than one
> sibling.

---

## 10. Migration plan

Ordered so each step ships independently and is verifiable on its own — matching the
established working style of small verifiable slices, and using the REAL / PASSTHROUGH / SEAT
labelling convention for anything stubbed ahead of its implementation.

### Step 1 — Extract `@cpg/cpg-model` *(mechanical; unblocks everything)*

Move `contract.ts` verbatim into a new zero-dep package. Rewrite the five deep imports to
normal barrel imports. Have `graph-visualizer` re-export for webview convenience. Delete the
four copies of the deep-import rationale and the AGENTS.md rules they enforce.

*Verify:* `npm run compile` clean; `grep -r "dist/contract" src packages` returns nothing;
extension still renders a graph.

### Step 2 — Add the `GraphSink` output seam *(PASSTHROUGH)*

Define `GraphSink` in `cpg-model`. Add a `sinks: GraphSink[]` option to `parseWorkspace` /
`monitorWorkspace` alongside the existing `onDelta`, implemented as a passthrough adapter that
wraps today's callback. Nothing changes behaviourally; the seam now exists to build against.

*Verify:* existing `onDelta` path untouched and still working; a throwaway console sink
receives the same deltas.

### Step 3 — Structured events *(replaces nine listeners)*

Define `EngineEvent` / `EventSink` in `cpg-model`. Emit from every pass. Move `PARSE_LOG_INTERVAL`
throttling and all `relative()`/string formatting out of `WorkspaceSession` and into the
extension's event sink, where the 200-entry panel cap actually lives.

*Verify:* Insights panel output is unchanged; the engine contains no user-facing strings.

### Step 4 — Wire up a test runner *(do not defer past here)*

Add `vitest`. First suites, using fakes that already exist: `ChangeBatcher` with its injected
clock; `WorkspaceGraphIndex.applyChange` idempotency; `GraphBuilder` symbol survival across
`replaceFile`; the `resolveHarness` assertions as golden tests over a checked-in fixture
workspace (which also removes the hardcoded `~/projects/demos/ast-demo` path).

*Verify:* `npm test` green; add it to a CI job.

### Step 5 — Split `@cpg/file-watcher` into `watch` + `workspace-scan` + `engine`

Three new packages, mostly file moves. `@cpg/watch`'s `package.json` should depend on
`cpg-model` and **nothing else** — that dependency list is the architectural assertion.

*Verify:* `@cpg/watch` builds standalone against a fake backend with no other `@cpg` package
installed.

### Step 6 — Move the composition root into `@cpg/engine`

`WorkspaceSession` → `createEngine(config)`. `src/extension.ts` reduces to adapter construction
plus one `createEngine` call.

*Verify:* the extension behaves identically; `src/` imports only `@cpg/engine`,
`@cpg/cpg-model` and `@cpg/graph-visualizer`.

### Step 7 — `@cpg/cli`

A real `bin` over `createEngine` with a Node watch backend. `resolveHarness.ts` deletes down to
its fixtures and assertions.

*Verify:* `npx cpg scan <path>` produces the same graph the extension does, with no VS Code
running. **This is the proof that the vision is met.**

### Step 8 — Split `GraphBuilder`; add the store seam *(SEAT)*

`FileNodeRegistry` / `SymbolRegistry` / `DefinitionIndex`. Add a `GraphStore` sink
implementation stubbed as SEAT, so the FalkorDB work has somewhere to land.

### Step 9 — Rewrite `docs/architecture/service-boundaries.md`

Against the real layout, keeping its delivery-contract substance intact.

### Steps 1–4 are the ones that matter most.

If only four things get done, do those: they remove the inversion, create the output seam,
kill the string-formatting leak, and make the whole thing safe for a second person to touch.
Steps 5–7 are the vision; steps 8–9 are consolidation.

---

## 11. Rules worth enforcing mechanically

Comments currently carry the architecture. Move as much as possible into the build.

1. **`@cpg/cpg-model` has an empty `dependencies` block.** A CI check on that one fact
   structurally guarantees the import-free rule that four comments currently plead for.
2. **A dependency-direction check in CI.** `eslint-plugin-boundaries`, `dependency-cruiser`, or
   twenty lines of script over each `package.json`. One rule: nothing depends on
   `graph-visualizer` except `src/`.
3. **`exports` maps on every package.** Deep imports become resolution errors rather than
   review findings.
4. **A package's `dependencies` block is its architecture statement.** `@cpg/watch` depending
   only on `cpg-model` *is* the decoupling. Review it as such.
5. **Keep the "why" comments.** They are the best asset in this codebase. But a rule that the
   compiler can check should be checked by the compiler, with the comment explaining the
   reasoning rather than doing the enforcing.

---

## Appendix: what's already right

Worth stating, because a review that only lists problems misrepresents the codebase:

- `WatchBackend` and `Resolver` are the correct pattern, correctly executed, with the reasoning
  written down. The whole plan above is essentially "do that three more times, and put the
  results somewhere reachable."
- The symbol-identity design — routing cross-file edges through fqn-keyed `SYMBOL` nodes so a
  re-parse can't invalidate another file's edges — is genuinely subtle and correctly reasoned.
  `CpgSubgraphLike.symbols` being a separate channel from `nodes` is the right call and is
  documented as the load-bearing invariant it is.
- `SourceRange`'s UTF-16 column contract is documented, empirically verified rather than
  assumed, and names the exact type whose breakage would propagate. That is unusually careful.
- `relationshipTypes.ts`'s derive-and-fallback approach is the right pattern; it just needs to
  be applied to `nodeTypes.ts` too.
- `docs/architecture/service-boundaries.md`'s delivery contract is better than what's currently
  implemented. It should be restored, not reinvented.
