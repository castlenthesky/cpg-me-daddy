# 00 — Project Charter

**Project:** cpg-me-daddy (CLI binary `cpg`, npm scope `@cpg/*`)
**Charter date:** 2026-09-17
**Owner:** Brian Henson
**Repository:** `castlenthesky/cpg-me-daddy`, branch `develop`, merges to `master`

## 1. Purpose

Build a tool that keeps a **live, machine-verifiable, sparse structural graph of a codebase** current within two seconds of a file save, runs entirely under plain `node` with no editor present, and exposes that graph to whichever consumers the user switches on: a browser-based interface, a picture, a FalkorDB store queryable in Cypher, a VS Code panel, and later an MCP server for coding agents.

The graph answers the questions a developer or an agent asks before changing code: what is in this repository? who calls this? who imports this? what is unreachable? where are the import cycles? what breaks if I change this? Where are the taints? which areas of code are tightly coupled? Do we have high or low cohesion? Centrality? betweeness centrality? And other graph-based analytic insights for code. It answers them from a structure that is always current, rather than from re-reading text or from an index that was built yesterday.

## 2. The problem

Source code - as a tool receives it - is a byte string. Every structure a programmer sees — files, modules, classes, calls, the fact that a call in one file reaches a definition in another — is rebuilt by a chain of translators, and existing tools stop that chain at a syntax tree, per file, and rebuild it from scratch when asked. Two consequences follow, and this project exists because of them:

1. **Cross-file structure is invisible to per-file tools**, so the questions that matter most (who depends on this, what does this reach) are answered by grepping text or by re-indexing the whole repository. A study of five open-source code-graph tools found that four of the five resolve cross-file identity with a whole-corpus relink on every run, and none of the five is incremental at the graph-write level. Near-live incremental update is unoccupied ground, not a catch-up feature (`10-lessons.yaml` L-46, L-47).
2. **Agents make worse changes when they cannot see structure.** The working systems that give language models code context all hand the model small, ranked, structural answers ("what breaks if I change this") rather than raw text or raw database access. A graph that is always current is what makes such answers trustworthy.

## 3. Why the previous two attempts failed, and what this charter changes

This is the third attempt. The first (`archive/master-20260916`) was an engine-first monorepo writing a Joern-shaped graph into FalkorDB; it stalled because twelve gated units passed before any human saw a graph, and what they saw was a Cypher result table (L-22). The second (`archive/discovery-20260916`) was a visual-first redo; it produced a real picture quickly and then let the picture's types become the system's types, trapped the composition root inside the editor so that running headless required a 442-line duplicate harness, and shipped zero tests (L-26, L-28, L-30). Both attempts hid the same unowned component in the middle of the pipeline, and both had write paths that destroyed real data (L-01, L-02, L-03).

This charter changes four things:

- **The engine is the product; the editor is a consumer.** There is exactly one graph producer, it always runs, and every consumer is optional (principle P-A below). This is enforced by directory structure and a build gate, not by review.
- **Correctness is decided by code, not by looking.** A measured experiment showed the rendered picture cannot detect any of four corruption classes, including a stale subgraph, which is the exact failure the freshness promise exists to prevent. The gate for every milestone is `cpg verify` exiting 0 (principle P-B).
- **The unowned middle has owners.** Every stage of the pipeline owns named data and forbids itself from touching the rest (`03-architecture.md` stage-ownership table).
- **Order by time to first human judgement.** A human sees their own repository in the second milestone, and every milestone after it produces something a person can look at, in addition to what the machine asserts.

## 4. The user

The user this design serves first is **a developer who lives in a terminal and does not open an editor at all.** For that user the CLI is the entire product. Everything else — the browser picture, the VS Code panel, FalkorDB, MCP — is something they switch on if they want it and pay nothing for if they do not. The VS Code developer is served by the same producer with a particular set of consumers enabled. The coding agent is served by the MCP consumer and by the same `cpg verify` guarantees a human relies on.

This is why constraint 1 below outranks everything else, and why it is a product requirement rather than architectural hygiene: if the composition root drifts into the editor again, the terminal user has no product.

## 5. Goals

1. **Code quality.** Detect architectural smells that need structure to see: import cycles, unreachable declarations, hub files and hub symbols, layer violations (north star), god classes (north star).
2. **Agent understanding.** Give coding agents structured, current, queryable context through MCP: find a symbol, callers and callees, impact of a change, a path between two points, graph status.

## 6. Non-goals for v1 (recorded, not forgotten)

Each row has a trigger in `02-decisions.yaml`; none is rejected outright.

- Control-flow graph, control dependence, dominators, and any data flow beyond the sparse `REACHING_DEF` edge. Names are reserved in the schema; the statement-level identity slot in the id rule is tested so adding them later is additive, not a re-identification.
- Taint tracing, sources, sinks, sanitizers, findings.
- Expression-tier nodes (identifiers, literals, locals) as a bulk tier. Measured at 5.5–5.9× the structural node count against a write budget already 66–82% consumed; "collect now, prune later" is rejected by measurement.
- Persisted architectural labels, layer rules, agent write-back, annotations.
- A detached daemon. MCP reads through the store; a shared engine process arrives when a second process needs the producer live.
- Windows native FalkorDB, multi-root workspaces, remote agents, HTTP MCP transport, any MCP write tool.
- Parsing unsaved editor buffers. A graph built from dirty buffers cannot be reproduced by `cpg index`.

## 7. Constraints, ranked

When two constraints conflict, the lower-numbered one wins. This is the tie-break of last resort and it has decided several recorded questions.

| rank | constraint | what it means in practice |
| --- | --- | --- |
| **1** | **CLI-first** | The engine runs under plain `node` with **zero `vscode` imports**, enforced by a build gate that has been proven to fail on violation, plus a runtime proof that loads the whole engine and asserts no `vscode` module was requested. The extension is a consumer, never a prerequisite. |
| **2** | **Visual validation** | The VS Code debug host is the primary way a human checks that the system is alive and worth continuing. It is not the gate; `cpg verify` is. When both the browser picture and the VS Code panel exist, the panel outranks the browser for daily use. |
| **3** | **Freshness** | From the moment a file is saved to the moment the change is visible in every enabled consumer, including FalkorDB and the picture, is under 2 seconds. The clock is the human's (T0 = filesystem event), not the pipeline's, and the number is always reported with the set of consumers that were enabled. |
| **4** | **VS Code dependency hygiene** | Clean architecture at the editor boundary: the host may supply consumers and configuration; it may never supply input to the producer. |
| **5** | **Sparse graph** | The graph stores one node per thing a developer or agent would name, never one per token. Prunable later in principle; in practice measured as met with 3.5–4× headroom, so no pruning pass is planned. |

## 8. Principles

Three principles were established by the human's own answers to the decision queue and now govern the design. Eight older principles are carried forward unchanged.

**P-A — The producer always runs; every consumer is optional and configurable.** There is exactly one graph producer. Everything else — browser picture, FalkorDB store, MCP server, VS Code panel — is a consumer you switch on. A terminal user who wants raw throughput runs the producer alone. The VS Code extension is the producer launched with a particular set of consumers enabled. Consequences: the freshness budget is per enabled consumer set; a verification check that needs a renderer reports `unavailable` when no renderer is enabled, which is a correct answer; FalkorDB is a consumer like any other. Corollary: **VS Code can drive several lifecycle hooks and it must not** — editor events, unsaved buffers and workspace folders are all temptations to make the host the producer's source of truth, and every one breaks the terminal user.

**P-B — Revision reconciliation is the correctness spine.** Every node carries the `revision_id` of the file it was derived from; the FILE node carries the content hash; a node whose `revision_id` does not match its file's is stale, provably, by query. One indexed comparison catches staleness, dropped subtrees and duplicated files at once, and it gives the freshness promise something to measure against. Edges carry no revision; if a node's revision changes, its edges are up for re-evaluation by construction.

**P-C — The schema is versioned and evolvable, not frozen.** The 14 node labels and 15 edge types are settled and protected from re-litigation. The properties on them are expected to grow as implementation teaches us things. Adding a property is free. Adding a type needs one paragraph of rationale. Renaming, removing or changing meaning needs the reopening test.

Carried principles (from the 2026-09-11 vision session): **PR1** sparse by design · **PR2** speed is the product; never re-parse the whole codebase for a one-line change · **PR3** the graph is a cache, fully rebuildable from source · **PR4** concurrent read/write; readers never see torn state silently · **PR5** deterministic identity; a file move is a relocation, not a rebuild · **PR6** show what matters when it matters; whole-graph rendering is an anti-goal · **PR7** privacy and local compute; no telemetry, no remote calls unless opted in · **PR8** state is always explicit; every node carries its freshness.

## 9. Success criteria

| # | criterion | how it is measured | when it is first measurable |
| --- | --- | --- | --- |
| S1 | A developer with no editor open runs `cpg index .` on their own repository and sees it rendered | `cpg verify` exit 0 + human looks at the picture | U2 |
| S2 | The engine loads zero `vscode` modules under plain `node` | runtime `Module._load` trap in CI, with an anti-vacuity check that proves the trap fires on a planted import | U2 |
| S3 | Save → visible in every enabled consumer < 2 s, human clock, reported with the enabled set | `renderedSeq`/`confirmedSeq` measurement points, p95 over a fixture | U4 (file tier), U7 (code tier) |
| S4 | Every node's `revision_id` reconciles with its file's; every file on disk has a FILE node | `cpg verify` `revision-reconciliation` and `filesystem-reconciliation` checks | U2 |
| S5 | FalkorDB is written with exactly one Cypher statement per file | CI asserts `receipt.statementCount === 1` | U5 |
| S6 | The headless resolver is never wrong where it answers | 0 disagreements against the language-server oracle; recall reported against the measured ceiling | U6 (imports), U8 (calls) |
| S7 | Structural sparsity holds | nodes/LOC ≤ 1.5 asserted in CI (measured 0.36–0.43) | U6 |
| S8 | First launch on ~100k LOC completes in ≤ 10 minutes | scale fixture, local benchmark | U7 |
| S9 | An agent with the MCP consumer detects and mitigates seeded bugs > 95% | eval harness over a hand-audited golden fixture | after U10, deferred until the golden fixture exists |

## 10. Scope

**In v1:** filesystem tier (directories, files), declarations (modules, types, methods, params, members), calls and imports with a five-value resolution status, cross-file identity through `SYMBOL` nodes, sparse intra-file `REACHING_DEF`, an overlay of derived edges (`TARGETS`, `DEPENDS_ON`, `COMMUNITY`) recomputed off the hot path; Python first, TypeScript second; a CLI with `index`, `watch`, `verify`, `inspect`, `schema`, `query`, later `mcp` and `status`; consumers: memory store, browser inspector, VS Code panel, FalkorDB, MCP.

**Out of v1:** everything in §6.

## 11. Working process

These rules are scars, not preferences. Each cites the lesson it prevents.

- **Order by time to first human judgement, not dependency depth** (L-22). If the first thing a person can look at is twelve units away, the plan is wrong.
- **The gate ships with the code** (GR2, L-31). A gate is defined by what runs it. Every gate has an automated trigger or is explicitly a manual gate with a named owner and a merge block.
- **One unit = one branch = one PR, 200–500 reviewable lines** (GR1, GR3). Run the gate locally, verify green, then push. CI is a second opinion, not the first run.
- **REAL / PASSTHROUGH / SEAT** (L-37). Land the whole shape compiling with each body labeled by how real it is, before building any piece for real. "Architecture agreed" and "feature works" become two separately checkable claims.
- **Smallest verifiable slice** (L-36). Something a human can look at lands before the next layer goes on.
- **START SIMPLE** (L-43). Do not add a generalization before its second concrete caller exists.
- **Spikes are units** (GR6). A spike's pass/fail threshold is the gate of the unit it de-risks; there is no separate research backlog.
- **Manual gates are real gates** (GR5). A PR with a step only the owner can perform does not merge until it happens.
- **Goldens guard regressions; humans judge pictures and short tables** (L-23). Never let one artifact claim both roles.
- **Every delete funnels through one narrowly scoped method** (L-02). When you fix a destructive write, grep the whole repository for the shape of the query, not the name of the function.
- **Parameterize every value; allowlist every label** (L-09).
- **Comments explain why; the compiler and CI enforce** (L-41). When the same rationale comment appears twice, the fix belongs in the dependency graph.

## 12. Roles

- **Owner** decides everything in `02-decisions.yaml`, performs manual gates, and reviews each milestone's human artifact.
- **Implementers** (human or agent) take stories from `07-milestones.yaml`, port from `11-salvage.yaml`, and pass the gates in `08-verification.md`.
- **Reviewers** check a PR against the in-force decisions and the unit's gate, and refuse a PR that changes a number without updating `06-measurements.yaml`.

## 13. Risks the plan carries knowingly

| risk | severity | mitigation in this plan |
| --- | --- | --- |
| The resolver term dominates the save budget (88% of 1,674 ms at p50 for a 1,068-line Python file) and fails at any tail | high | The resolver verification harness (epic E-VERIFY) lands with the first cross-file edges at U6 and grows through U8/U9; the freshness promise is stated per consumer set and per measured budget, never assumed |
| Cascade is unbounded without interface-hash gating | high | `interface_hash` is emitted by extraction at U6 and gating is enforced at U7; over-budget dependents are marked `stale` with a reason rather than blocking |
| Name resolution quality determines cross-file edge quality | high | Precision invariant (0 disagreements) enforced in CI; recall reported against a measured ceiling; `EVAL_TYPE` admitted only at ≥95% of ceiling |
| TypeScript resolution is unmeasured | medium | U9 opens with a one-day spike with a pre-declared threshold; nothing TS-specific is promised before it reports |
| Watcher stampedes (git checkout, npm install) | medium | Bulk-mode thresholds from measured prior art; bulk processing is explicitly outside the freshness budget in v1 |
| The picture invites false confidence | medium | Labeled a liveness check everywhere; `cpg verify` is the gate |
| FalkorDB licensing (SSPL) and Windows coverage | medium | Docker and remote modes only in v1; SSPL review before any marketplace listing that downloads binaries |
| A single plan document rots as its predecessors did | medium | This directory is checked three ways: archive-coordinate resolver in CI, schema drift check from U1, and the retirement battery re-run at every milestone boundary (`12-retirement.md`) |
