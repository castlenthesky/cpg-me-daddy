# Errata: what this session's record no longer reflects

This directory is a verbatim carry-over of the 2026-09-11 planning session
(`00-vision.yaml` through `60-delivery.yaml`, `potential-development.yaml`, and the `research/`
spikes R1–R6). It is the richest single "why" record in the project — 8 principles, 14
proposals, 37 decisions, backed by 6 research spikes — and most of it is still accurate. It is
kept unedited on purpose: proposals, decisions, and Q&A are a historical transcript, not a living
document, and rewriting them in place would destroy the record of what was actually decided and
why at the time.

But two things decided here have since been reversed or reverted, and reading this corpus without
knowing that will actively mislead you.

## 1. The headless-engine constraint (X1/D4/D8) is reversed

`00-vision.yaml` records proposal **X3** rejecting `vscode.executeDefinitionProvider` as a
resolver because it "only works inside VS Code — conflicts with X1," where **X1/D4/D8** commit to
a headless, standalone-daemon engine with the extension as a thin host.

**On 2026-09-15 this was reversed.** `vscode.executeDefinitionProvider` is now the *primary*
cross-file symbol resolver, sitting behind a `Resolver` seam so a headless resolver can still be
chained or swapped in later. The reason X1/D4/D8's premise no longer holds: the headless engine
they describe (the `cli`/`engine`/`vscode`/`falkordb-service` packages) was deleted in the
`discovery` rebuild (commit `4cbf180`) before this decision was revisited, so "must run headless"
had already been downgraded from a hard constraint to a future option. See
`docs/architecture/current-target.md` and `docs/plans/unified-architecture.md` (§0, §1, decision
D8 in §6) for the current framing: the engine runs identically in every host, and which
`Resolver` implementations are available — not whether the engine itself can run — is what varies
by host.

**How to read X1/X3/D4/D8 now:** as the record of why headless was originally the plan, not as a
statement of current constraints.

## 2. The tooling stack (Bun + oxlint + lefthook) was tried and reverted

Decisions in this corpus around tooling (see `60-delivery.yaml`'s F1 unit and related DL-numbered
notes) committed to Bun workspaces, oxlint, oxfmt, and lefthook as the standing gates. That
tooling was built (`4e3ddab feat(F1): bun workspace monorepo skeleton + standing gates + CI`) and
then **reverted** on `discovery`, back to plain npm + tsc, along with the `cli`/`engine`/`vscode`/
`falkordb-service` packages the F/M0 unit ladder in `60-delivery.yaml` was built around.

The revert was about **process**, not about the tools being wrong: that implementation round got
over-architected without enough visual/manual verification checkpoints along the way, and had to
be scrapped when it couldn't be confirmed sound as it progressed. Bun/oxlint/oxfmt are expected to
come back once the current incremental, verification-gated redo is far enough along to support
reintroducing them safely — see `docs/plans/unified-architecture.md` §6 ("Tooling").

**How to read the F/M0 unit ladder now:** the *ordering lessons* in it are largely still valid and
are cited directly in `unified-architecture.md` §1 ("From `main`: the process failure,
precisely"). The specific packages and tooling it assumes are gone; don't resurrect them assuming
they're current.

## Everything else in this directory

The database-selection decision (D1, benchmarked separately in `../database-selection/`), the
schema in `50-schema.md`, the SYMBOL-indirection design (D5), the sparse/statement-level
granularity principle (PR1), and the research spikes R1–R6 are not known to be superseded and
should be read as current unless `docs/plans/unified-architecture.md` §6 says otherwise.
