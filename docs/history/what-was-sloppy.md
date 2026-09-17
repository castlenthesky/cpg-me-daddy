# What "sloppy" looks like here

Concrete failure patterns from across the project's history, with the evidence for each, so they
don't have to be rediscovered. Paired with `what-worked.md`. See `timeline.md` for the events
these are drawn from, and `docs/history/archive/journal/` for the original bug write-ups in full.

## Data-destroying bugs from unaudited write paths (original implementation)

Four dated journal entries (2026-04-03/04, `docs/history/archive/journal/`) record concrete bugs
in the pre-rewrite implementation, each root-caused and fixed:

- A wildcard `DELETE` in the graph reconciler that wiped the *entire* graph, not just the node
  being reconciled — found and fixed twice, meaning the first fix didn't cover every call site.
- Cypher injection via naive string interpolation into queries.
- TOCTOU (time-of-check-to-time-of-use) races in file-state handling.
- An unconditional force-graph "reheat" (full re-layout) on every save, regardless of whether
  anything the layout depends on actually changed.
- A silent fallback that masked language-detection errors instead of surfacing them.
- A `DETACH DELETE` that destroyed cross-file edges it shouldn't have touched.

The pattern across all six: **write paths that weren't scoped as narrowly as the intent behind
them**, caught only after the fact. This is the direct ancestor of the SYMBOL-indirection design
and the file-owned-vs-identity node distinction later adopted specifically so a per-file operation
cannot reach into another file's data — see `what-worked.md`.

## Bottom-up ordering that put the interesting part last

The Bun-era delivery ladder (F1–F4, then M0.0–M0.11) sequenced tooling, a Docker FalkorDB harness,
binary acquisition, and grammar setup *before* a human could see anything, and scheduled symbol
resolution — cross-file edges, the actual point of a code graph — at M0.10, second to last. Twelve
gated units passed before a human saw a graph at all, and what they saw first was a Cypher result
table, not a picture. The plan's own DL14 note (2026-09-12) is the tell: it explicitly notices
partway through that it should "start getting real data into the graph … by the shortest honest
route" — i.e., the plan had already built the wrong thing first and was correcting mid-flight.

## A verification surface that isn't actually auditable by a human

The same era made a passing golden-JSON snapshot diff the sign-off mechanism for correctness
(GR4). A multi-hundred-node JSON diff is not something a person reads and confidently says "yes,
that's right" — it's machine-checkable regression protection, not human verification, and treating
it as the latter is how an over-architected system can pass its own gates while still being wrong
in ways nobody looked at.

## A store in the critical path before there was anything to store

The FalkorDB/Docker harness was stood up at unit 2, before extraction or resolution existed to
produce anything worth storing. Every subsequent gate then required `docker compose up` to pass,
adding infrastructure weight to steps that had nothing to do with storage yet.

## Type vocabulary living inside the wrong package

On `discovery`, the project's core data model (`GraphNode`, `GraphEdge`, `GraphPayload`,
`GraphDelta`, etc.) was defined inside `graph-visualizer` — the DOM/WebGL rendering package —
despite containing nothing about rendering. Every other package had to reach past the package
boundary with a deep import (`@cpg/graph-visualizer/dist/contract`) to use it, each site carrying
its own paragraph of comment explaining why, and the rule was enforced only by code review, not
by the compiler — so it could be, and was, silently violated by a later `dist/layout` deep import
elsewhere. Four separate copies of the same rationale is a sign the fix belongs in the dependency
graph, not in a comment.

## A package that isn't what its name says

`@cpg/file-watcher` contained, alongside a genuinely well-scoped 46-line watcher core, the
workspace scanner, the AST pass, the resolve pass, and phase orchestration — roughly 1,300 lines
in a package whose name suggested none of that. A package no one can reason about from its name is
a package two people will end up editing without realizing they're touching the same thing.

## A composition root trapped where only one host can reach it

The only place `discovery`'s pipeline was ever assembled was inside the VS Code extension
(`src/workspaceSession.ts`). Running it without VS Code required a 442-line hand-rolled duplicate
(`src/dev/resolveHarness.ts`) — three and a half times the size of the 120-line class it exists to
exercise — that also hardcoded one developer's local filesystem path as its default workspace,
making it a personal script rather than a team asset. A large duplicate harness reimplementing a
small class from scratch is a direct symptom of a missing seam, not a separate problem to fix on
its own terms.

## Debug output living in the hot path, defaulting to on

AST dumps to disk happened as a pipeline stage on every save (`dumpAstToDisk` defaulting to
`true`), rather than as an optional subscriber to output — meaning debugging instrumentation could
slow down or fail the live parse path it was meant to be observing from the outside.

## No test runner despite seams built specifically to be tested

`discovery` built several seams explicitly so they could be faked and tested in isolation
(`WatchBackend`, `ChangeBatcher` with an injectable clock, `Resolver`'s `FixtureResolver`) and then
had no test runner at all — the infrastructure for confidence existed and went unused. This is
listed in the architecture review as the single biggest blocker to more than one person working in
the codebase confidently.

## Design docs that went stale the moment the code was rebuilt underneath them

`docs/architecture/service-boundaries.md` specifies a genuinely good delivery contract, but every
file path in it (`packages/engine/src/watch/*`, `packages/vscode/src/extension.ts`, …) refers to a
package layout that no longer exists after the `discovery` rebuild — the design didn't get
rewritten in lockstep with the code that made it stale. Read cold, it is "authoritative in tone,
correct in substance, and unfollowable in specifics" — worse than an admittedly-outdated doc,
because nothing about it signals that it's outdated. The same failure mode, one level up, is why
this centralization effort exists: `develop`'s own "aggregate strategy" doc turned out to be a
byte-identical, un-updated copy of `discovery`'s snapshot, not an actual synthesis of its own.
