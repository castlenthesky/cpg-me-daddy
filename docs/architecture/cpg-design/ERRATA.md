# Errata: what these design docs no longer reflect

This directory is a verbatim carry-over of the CPG design series (`00-Overview.md` through
`06-Taint-And-Code-Quality.md`, plus the Joern-alignment spec and schema) that was maintained
identically on both `master` (`design/02_planned/CPG/`) and `discovery`
(`.agent/knowledge/design/02_planned/CPG/`) — the two trees were byte-identical. It is kept
verbatim for the same reason as `../../research/2026-09-11-planning-session/`: it's a detailed,
expensively-produced spec, and editing it in place would blur what was actually specified.

## What's stale

This series was written under the same **headless, standalone-engine** assumption recorded in the
2026-09-11 planning session's `00-vision.yaml` (proposals X1/X3, decisions D4/D8). That assumption
is **reversed** as of 2026-09-15: `vscode.executeDefinitionProvider` is now the primary
cross-file resolver, behind a `Resolver` seam. See
`../../research/2026-09-11-planning-session/ERRATA.md` for the full explanation and
`docs/architecture/current-target.md` / `docs/plans/unified-architecture.md` for the current
architecture.

Any passage here that frames VS Code's language-service APIs as off-limits, or that assumes the
engine's only realistic host is a standalone daemon, should be read as **the reasoning that was
current in the pre-`discovery` implementation**, not as a constraint that still holds.

## What's still normative

The Joern-alignment vocabulary and layer structure (UAST → CFG → PDG → FalkorDB storage →
visualization → taint/quality) is not known to be superseded on its own merits — it's the schema
`unified-architecture.md` §3.3 treats as normative (via `50-schema.md`, the schema produced from
this same design lineage). Read the *shape* (labels, layers, storage model) as current; read the
*hosting assumptions* per the note above.
