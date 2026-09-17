# Status: what's true right now

A single at-a-glance answer to "what's current," so nobody has to reconstruct it from the fuller
history in `docs/history/` or the research corpus in `docs/research/`. If this file and any other
doc disagree, this file wins for *current state*; the other doc likely just hasn't been reconciled
yet — fix it if you notice.

## Active branch and milestone

`develop`, currently a bare-bones VS Code extension scaffold (`packages/ast-generator` stubbed,
TS project references wired across `packages/*`). The active implementation slice is the first
post-revert redo step: workspace file traversal → JSON → rendered in the graph webview
(`src/webview/graphApp.ts`), extended with a two-phase activation flow — **ParseWorkspace** (full
walk) and **MonitorWorkspace** (live changes) — feeding one shared update path
(`UpdateQueue` → `WorkspaceGraphIndex` → `GraphDelta`), landed as a compiling, labeled
REAL/PASSTHROUGH/SEAT stub ahead of making each piece real. Don't jump ahead to AST/CPG generation
or graph persistence until this slice is confirmed working end to end.

## Decisions currently in force

- **`vscode.executeDefinitionProvider` is the primary cross-file symbol resolver**, behind a
  `Resolver` seam so a headless resolver can still be chained in later. This **reverses** the
  2026-09-11 planning session's D8/X3 (see `docs/research/2026-09-11-planning-session/ERRATA.md`).
- **Cross-file edges route through visible, fqn-keyed `SYMBOL` nodes**, in a channel separate from
  a file's own nodes — not direct edges between call sites and definitions.
- **Python first, TypeScript second** for the extraction/language-adapter work.
- **Tooling is npm + tsc + vitest**, not Bun/oxlint/oxfmt/lefthook. That stack was built, then
  reverted for lacking verification gates, not for being the wrong tools — it's expected back once
  the current redo is far enough along to support it (`docs/plans/unified-architecture.md` §6).
- **FalkorDB is a tier-2 store, not the first thing built.** It enters at the point a
  separate-process reader needs it (the MCP wedge), with an in-process `MemoryStore` as tier 1
  from the start. This amends the original D2 (`unified-architecture.md` §6).

## The two documents that define "where we're headed"

- **`docs/architecture/current-target.md`** — the structural diagnosis of `discovery` (seam
  craft is good, seam *placement* isn't) and the target package layout + 9-step migration plan.
- **`docs/plans/unified-architecture.md`** — the fuller synthesis reconciling `main`'s engine work,
  `discovery`'s visual-first redo, the planning corpus, and the competitive-landscape study into
  one 9-step delivery plan, with the amended decisions spelled out in its §6.

Neither has been fully executed yet against the current package layout — treat both as the target,
not the current state of the code, and check the code before assuming a described migration step
has already happened.

## Working process

- Build the smallest slice that produces something visually or manually checkable; confirm it
  before adding the next layer. Don't architect several layers up front.
- When landing a new seam ahead of its real implementation, stub the whole shape out first —
  labeled `REAL` / `PASSTHROUGH` / `SEAT` — compiling and agreed on its own, before any body behind
  it becomes real.
- See `docs/history/what-worked.md` and `docs/history/what-was-sloppy.md` for the evidence behind
  both of the above.
