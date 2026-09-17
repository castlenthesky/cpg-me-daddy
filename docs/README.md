# Documentation map

This directory centralizes research, design, and planning that used to be split across three
branches: `master` (the original implementation and its 2026-09-11 planning corpus), `discovery`
(the post-revert redo, its own architecture review and competitive research), and `develop`
(previously just a stale, uncustomized copy of `discovery`'s planning doc). Start with
**`STATUS.md`** for what's true right now; everything else here is the evidence and history behind
it.

## Where to look

| Directory | What's in it |
|---|---|
| **[`STATUS.md`](STATUS.md)** | What's currently active, which decisions are in force, and which two docs define the target architecture. Read this first. |
| **[`history/`](history/)** | `timeline.md` (chronological account of what was built, reverted, and why), `what-worked.md` and `what-was-sloppy.md` (concrete practices to repeat or avoid, each with its evidence), `archive/journal/` (the original bug write-ups those lessons are drawn from). |
| **[`research/`](research/)** | Primary research material: the 2026-09-11 planning session (vision, principles, decisions, schema, delivery ladder — with an `ERRATA.md` noting what it gets wrong now), the database-selection study, the five-tool competitive-landscape study, and early CPG-applications research. Mostly read-only historical record; check each directory's `ERRATA.md` before treating anything as current. |
| **[`architecture/`](architecture/)** | `current-target.md` (the structural review of `discovery` and its migration plan — the closest thing to "current boundaries" in the repo), `cpg-design/` (the Joern-aligned schema/layer spec, with its own `ERRATA.md`), `service-boundaries.md` (a sound pipeline contract with stale file paths, flagged inline). |
| **[`plans/`](plans/)** | Forward-looking, still-open plans: `unified-architecture.md` (the full synthesis and 9-step delivery plan), `tie-ast-to-parent-file.md` (a scoped implementation plan — verify against current code before acting on it). |

## How to keep this from going stale again

Two failure modes already happened once each in this project's history and are worth guarding
against on purpose (see `history/what-was-sloppy.md` for the full account):

1. A design doc's *content* went stale because the code was rebuilt underneath it without the doc
   being updated in the same change. If you rebuild something a doc here describes, update or flag
   that doc in the same PR — an `ERRATA.md` note is enough if a full rewrite isn't warranted yet.
2. A branch's own "current strategy" doc turned out to be an unedited copy of another branch's
   snapshot. If you copy a doc across branches, treat it as a starting point to reconcile, not as
   done.
