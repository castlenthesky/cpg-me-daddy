# Service boundaries: the change pipeline

`cpg-me-daddy`'s live-update path is a pipeline of mutually ignorant stages:

```
file watcher  ──change stream──▶  engine (re-parse)  ──AST/CPG delta──▶  graph DB  ──▶  visualization
```

Each stage knows only its own input and output contract — never how its neighbor is
implemented, whether it's even running in the same process, or what it does with what it's
given. This document records that contract seam by seam: what crosses each boundary, who owns
retry, who owns ordering, and what each side is forbidden to know. It also records the
direction each seam is headed, so a contract that looks minimal today reads as deliberate
rather than incomplete.

## Why this split, not one pipeline object

The alternative — a single orchestrator that watches, parses, and writes — is what
`packages/engine/src/watch/watch-workspace.ts` used to be: `watchWorkspace` took an
`IGraphStore` in its own dependencies and called `writeFilesystem` on it directly. That
collapsed two independently-useful things into one: you couldn't test the watcher without a
graph store, reuse it against a different store (or no store — a pure change log), or run
it standalone from a re-parser that doesn't yet exist. Splitting the pipeline at each stage's
natural seam — "here is a change" / "here is a re-derived delta" / "here is a write" — is what
lets each stage be built, tested, and hardened independently, and lets a future consumer (the
AST re-parser, the visualization layer) attach without the watcher's code changing at all.

## Stage 1 — File watcher

**Owns:** noticing that something on disk changed, deciding whether it belongs in the graph
at all (excludes, size limit, symlink policy — `packages/engine/src/workspace/admit.ts`),
debouncing, deduplicating, and pairing a delete+create into a rename.

**Emits:** a `ChangeBatch` (`packages/engine/src/watch/sink.ts`) — a `seq`, a `cause`
(`"initial" | "live"`), and a list of `NormalizedChange`s (`packages/engine/src/watch/events.ts`):
`kind` (created/changed/deleted/moved), `entry` (file/directory), the workspace-relative
`path`, `fromPath` for a move, and — for a file create/change — a `contentHash` and
`sizeBytes`.

**Deliberately does NOT carry:** file bytes, decoded text, line counts, or a resolved
language. Those are graph vocabulary. A consumer that needs them re-reads the file itself —
one extra read per changed path, normally served from the OS page cache, in exchange for the
watcher never importing anything from `../store` or `../schema`. `grep -r '"\.\./store'
packages/engine/src/watch` finds nothing, and that's enforced by this document, not the type
checker — keep it that way in review.

**Delivery contract:** at-least-once, serialized, self-retrying.
`packages/engine/src/watch/queue.ts`'s `SerialQueue` guarantees at most one settled batch is
being derived and delivered at a time (closing the race where a slow consumer left a window
for two `processBatch` calls to interleave mutations to the watcher's own in-memory state).
`withRetry` gives a rejected `WatchSink.onBatch` call bounded exponential backoff before the
batch's paths are reported via `onDegraded` and given up on for now. The watcher's own known
state (`knownFiles`/`knownDirs`) only advances on confirmed delivery, so a failed write never
leaves it ahead of what a consumer actually has.

**What it is NOT yet:** proactively self-healing. A batch that exhausts retries is reported,
not retried again until a future filesystem event happens to touch the same paths — there is
no periodic reconciliation walk, no crash-resume via `@parcel/watcher`'s own
`writeSnapshot`/`getEventsSince` snapshot API, and no bulk-mode handling for a large
`git checkout` storm. All three are real, scoped future work, not silently dropped scope —
see "Deferred hardening" below.

## Seam: watcher → `WatchSink`

```ts
interface WatchSink {
  onBatch(batch: ChangeBatch): Promise<void>;
}
```

This is the entire contract. A sink is anything that wants to know what changed:

- **`packages/engine/src/indexer/filesystem-projector.ts`** — today's only sink. Turns a
  `ChangeBatch` into a `FilesystemDelta` (`store/cypher.ts`'s `planFilesystem`) and writes it
  via `IGraphStore.writeFilesystem`. This restores `cpg watch`'s pre-existing behavior exactly
  — `watcher -> projector -> store` — just with the store-writing code moved out of the
  watcher and into its own, independently-testable module.
- **A future AST/CPG re-parser** — not built in this pass. It would re-read a changed file,
  re-run tree-sitter extraction, and call `IGraphStore.writeDelta` the same way `cpg index`
  does today, closing the gap where a live-watched graph currently never gets
  MODULE/METHOD/CALL nodes (`cpg watch` only maintains the filesystem tier — see
  `watch-workspace.ts`'s own module doc). It would be another `WatchSink`, wired the same way.
- **A future visualization layer** — also just a `WatchSink`, notified of changes to redraw
  from, with no path back into the watcher.

**Who owns what, at this seam:**

| | Watcher (producer) | Sink (consumer) |
|---|---|---|
| Ordering | Guarantees `seq` order, one in flight | Trusts it, no locking of its own |
| Retry | Retries a failed delivery itself | Only needs to reject cleanly on failure |
| What crosses | Plain data (`ChangeBatch`) | Nothing crosses back except a Promise's resolution |
| Forbidden to know | What a sink does with a batch | How the watcher derived it |

## Stage 2 — Engine (re-parse) — not built in this pass

The user's stated direction: the watcher's stream feeds a re-parse stage that re-runs
AST/CPG extraction for changed files (mirroring `packages/engine/src/indexer/index-workspace.ts`'s
existing per-file extraction, `extract/index.ts`'s `extractFile`) and emits its own
`GraphDelta` forward. It would consume `ChangeBatch`es as a `WatchSink` and produce
`GraphDelta`s the same shape `cpg index` already produces — no new vocabulary needed, since
`schema/validate.ts`'s `GraphDelta` already exists and is what `IGraphStore.writeDelta` takes.

**What it must not know:** how the change stream was produced (whether from a live watcher,
a replayed log, or a test fixture), or what happens to the delta it emits.

## Stage 3 — Graph DB (`IGraphStore`)

Already exists (`packages/engine/src/store/store.ts`), already the seam both `cpg index` and
the filesystem projector write through. `writeDelta`/`writeFilesystem` are the only two
inbound calls either upstream stage makes; neither stage reads the graph back to decide what
to write next (the watcher's own `knownFiles`/`knownDirs` is the diffing state, kept
in-memory, not in the graph).

## Stage 4 — Visualization — not built in this pass

Reads the graph, or subscribes to whatever event bus eventually sits in front of it
(`GE-FR17`, `M1.8` in `60-delivery.yaml`). Out of scope here entirely; recorded so the
pipeline diagram above stays legible against where the project is headed.

## What this sprint deliberately did not build

Recorded so this document doesn't read as a promise this sprint kept:

- **AST-tier updates under watch.** `cpg watch` still only maintains DIRECTORY/FILE/HAS_ENTRY.
  Editing a file `cpg index` had parsed still leaves its MODULE/METHOD/CALL nodes stale until
  the next full `cpg index`. Closing this is Stage 2 above.
- **The detached daemon.** `.cpg/engine.json`, an `O_EXCL` lock, a unix socket, and
  attach-or-spawn semantics (decision D36, `00-vision.yaml`; `GE-FR15`/`GE-UC10`,
  `10-graph-engine.yaml`) are how the CLI and the VS Code extension become two clients of one
  running watcher instead of two independent short-lived processes. Not touched here — this
  sprint's watcher has exactly one caller (`cpg watch`) and stays that way.
- **The extension going attach-or-spawn.** `packages/vscode/src/extension.ts` still indexes
  in-process, once, on command; it does not yet call `watchWorkspace` at all.
- **Crash-resume, reconciliation, and bulk mode** (the watcher's own deferred items, listed in
  its module doc) — real gaps, scoped as follow-up work rather than attempted incompletely
  here.
- **`.gitignore` merging** — `packages/engine/src/config/workspace-config.ts` already assigns
  this to a later config-loading unit; unrelated to this pipeline split.

## Companion fix: the graph key is now per-workspace

Unrelated to the pipeline split above, but landed alongside it because it was a live
correctness bug: the graph key used to default to the flat constant `"cpg"`
(`store/falkordb.config.ts`). Node ids are workspace-*relative*
(`path:kind:qualifiedScopePath`), so two different workspace roots indexed with the default
config wrote into the same graph and collided — the second workspace's own scope-delete
(`store/cypher.ts`'s `planDelta`) would silently wipe nodes belonging to the first.

`packages/engine/src/workspace/hash.ts`'s `workspaceGraphKey(root)` now derives a stable,
`cpg_<12 hex chars>` key from the workspace root, wired in as `defineCpgConfig`'s *default* —
an explicit `--graph`, `CPG_GRAPH`, or the VS Code `cpg.engine.db.graph` setting all still
override it, unchanged. A workspace previously indexed against the flat `cpg` key needs one
re-index against its newly-derived key; nothing migrates automatically.
