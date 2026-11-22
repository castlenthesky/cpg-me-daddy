# What "good" looks like here

Concrete practices from across the project's history that produced work worth keeping, with the
evidence for each. Paired with `what-was-sloppy.md`. See `timeline.md` for the events these are
drawn from.

## Evidence-driven decisions with a stated fallback trigger

The database selection (`docs/research/database-selection/`) chose FalkorDB over five alternatives
using quantified benchmarks — p50/p95 latency, churn behavior, memory — at multiple graph sizes,
and named a specific fallback (LadybugDB) with the condition that would trigger reconsidering it.
That condition was never hit. This is the model for any decision that can be benchmarked rather
than argued: state the threshold, measure against it, write down what would change your mind.

## Seams that are zero-import, consumer-declared, and fakeable

`WatchBackend` and `Resolver` (both from `discovery`) are singled out in the architecture review
as "textbook": each is declared by the package that *consumes* it, has zero dependencies of its
own, is implemented by whichever host has the real capability, and can be swapped for a fake in a
throwaway script with no VS Code running. `resolve.ts`'s own comment states the payoff directly:
"the hard part … can be driven by a fake resolver in a throwaway `node` script." This is the
pattern `docs/architecture/current-target.md` recommends applying three more times (output seam,
event seam, storage seam), not reinventing.

## The smallest slice that produces something checkable

The `discovery` redo's first slice — file traversal to JSON, rendered in the existing graph
webview — deliberately proved the extension-host-to-webview pipeline end to end before anything
else was added, and every slice since has kept that discipline: something visually or manually
verifiable before the next layer goes on. Contrast with §"Bottom-up ordering" in
`what-was-sloppy.md` — this is the corrective, and it's held up, not just a one-time fix.

## REAL / PASSTHROUGH / SEAT before building anything for real

When the extension's activation flow was split into ParseWorkspace/MonitorWorkspace phases
(2026-09-14), the whole shape was named, wired, and left compiling — with every stubbed body
explicitly labeled as delegating to working code (REAL), doing the trivial version of its job
(PASSTHROUGH), or empty and commented for later (SEAT) — before any of the hard parts (async
parse, move-preserving renames, watcher wiring) were implemented. This makes "the architecture is
agreed" and "the feature works" two separately-checkable claims instead of one conflated one.

## Symbol identity kept in its own channel

`discovery`'s design routes cross-file edges through fqn-keyed `SYMBOL` nodes in a channel
separate from a file's own nodes (`CpgSubgraphLike.symbols`), specifically so that re-parsing one
file's contents can never sweep away another file's edges into it. The architecture review calls
this "genuinely subtle and correctly reasoned" and flags it as a load-bearing invariant worth its
own file and its own test — which is exactly how it's documented in the code.

## Letting outside evidence confirm or challenge a design before building more of it

The competitive-landscape study (`docs/research/competitive-landscape/`, five external code-graph
tools) wasn't performed to justify a decision after the fact — it validated real, load-bearing
choices before more was built on top of them: four of five tools studied hit the same "global
relink at load time" identity trap that the SYMBOL-indirection design exists to avoid; none parse
primarily via a language server, confirming tree-sitter-first; none are incremental at the
graph-write level, meaning per-file incremental replace is an actual differentiator, not table
stakes; and observed MCP tool-surface sizes (7–28, with more not correlating with more
sophistication) confirmed a ≤12-tool ceiling already planned as generous rather than restrictive.

## Correcting process without over-correcting on the tools

When the Bun/oxlint/lefthook stack was reverted, the reasoning was kept narrow: the revert was
because that implementation round lacked verification gates, not because Bun, oxlint, or oxfmt
were the wrong tools — the user's own assessment was that they were "probably the right choice" on
their own merits. They're expected to return once the current redo is far enough along to support
reintroducing them safely, rather than being treated as a closed question. Don't re-litigate tool
choice when the actual failure was process.

## Documenting a seam's "why," not just its shape

Both lineages' better seams (`WatchBackend`, `Resolver`, the ownership-class split in
`50-schema.md` §8, `SourceRange`'s UTF-16 column contract) carry a comment explaining the reason
the seam exists and what would break without it, not just a type signature. The architecture
review calls this out explicitly as worth keeping even as more of the *enforcement* moves from
comments into the compiler/CI (dependency-direction checks, empty-`dependencies` assertions):
"a rule that the compiler can check should be checked by the compiler, with the comment explaining
the reasoning rather than doing the enforcing."
