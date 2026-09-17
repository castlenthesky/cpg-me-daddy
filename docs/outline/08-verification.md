# 08 — Verification

## 1. The one sentence

**The picture proves the system is alive. Code proves it is correct.** Every milestone's gate is `cpg verify` exiting 0 plus the named tests, and every milestone also produces something a human looks at. Neither replaces the other.

## 2. Why the picture cannot be the gate

A measured experiment rendered a correct graph and four subtly corrupted ones twelve times each with different layout jitter. Re-rendering the *correct* graph changed 17.9% of pixels. The strongest corruption signal was 1.35× that noise. A deleted directory produced a graph that looked *fuller and more regular*, because the radial layout redistributed the survivors to close the gap (largest empty sector 30.20° versus 30.37° for the correct graph). A stale subgraph, the exact failure the freshness promise exists to prevent, fell inside the correct graph's own noise range on 4 of 12 seeds (`06-measurements.yaml → legibility`).

So the picture is demoted to a **liveness check**: it tells you something is flowing. Four kinds of machine assertion are required to tell you it is right, and they became the verify check set below. A freshness promise with no staleness assertion is unfalsifiable: the system can hit two seconds serving last revision's graph and the picture will confirm it looks fine.

## 3. `cpg verify`

```
cpg verify [dir] [--strict] [--format=json] [--consumers <set>]
```

Exit codes: `0` all checks pass · `3` a check failed (the tool worked; the graph did not pass) · `1` the tool itself failed · `2` usage. `--strict` treats `unavailable` as `fail`.

### 3.1 Six checks, four states

| check id | catches | asserts | source of truth | first live |
|---|---|---|---|---|
| `filesystem-reconciliation` | dropped subtree (C1) | the set of files the walker admits on disk equals the set of FILE nodes, per directory; offenders named per directory | walker + `store.fileStates()` | U2a |
| `identity-invariants` | orphaned symbol (C2) | every `CALLS`/`IMPORTS` target `SYMBOL` has a `DEFINES` edge from some file, **or** the edge's status is non-resolved (the target must *exist*, not merely have a resolution recorded); no node id is the virtual root | `store.readFile` over the payload | U6c (`unavailable` before) |
| `id-uniqueness` | duplicated cluster (C3a) | node ids are unique in the store/payload | `store.nodeKeys(label)` | U2a |
| `render-reconciliation` | silent renderer dedupe (C3b: 699 payload nodes rendered and *reported* as 658) | `renderedNodeCount === payload.nodes.length` | the renderer's `render-report` message | U2b; **`unavailable`** whenever no renderer consumer is enabled (ND-8) |
| `revision-reconciliation` | stale subgraph (C4) | every `:CPG` node's `revision_id` equals its `FILE`'s; every `FILE`'s `revision_id` equals sha256 of the bytes on disk | `store.staleNodes()` (one indexed query) + `FilesystemProbe.digest` | U2a (files), U6 (code tier) |
| `resolution-health` | a resolver that died mid-save leaving 59% of edges absent while everything else reconciles (CS-5) | `ResolveReport.degradedBatches === 0`; no backend `degraded`; `unresolvedRate` per kind reported and, from U8, within the declared threshold | `ResolveReport` | U6c (`unavailable` before) |

States: `pass` · `fail` · `stale` (the check's inputs lag the graph's `seq`) · `unavailable` (the check cannot be computed with the enabled consumer set). Report state is the worst of the six: `fail > stale > unavailable > pass`. Every `CheckResult` carries `observed`, `expected`, `localisedTo` (paths or ids), and `asOfSeq`, snapshotted before the check's first `await`.

Zero files indexed with no warning is a failure, not a pass: a broken include glob must not exit 0 quietly.

### 3.2 The revision reconciliation query (P-B)

```cypher
MATCH (n:CPG) MATCH (f:FILE {path: n.file})
WHERE n.revision_id <> f.revision_id
RETURN n.id, n.file, n.revision_id AS node_revision, f.revision_id AS file_revision
```

plus the disk side: for every `FILE`, `sha256(bytes) == f.revision_id`; for every admitted file on disk, a `FILE` exists. One mechanism catches staleness, dropped subtrees and duplicated files. What it cannot see, by construction, is a resolver that produced fewer edges than it should have while every node reconciles perfectly; that is `resolution-health`'s job.

Edges carry no revision (F-4). A cross-file edge A→B is re-evaluated whenever either endpoint node is re-derived; until U7 lands cascade, the freshness statement says in writing that a change to B's *interface* is not yet reflected in A's edges within the budget.

### 3.3 Where the verdict appears

- CLI: the report on stdout (`--format=json` is one `cpg.verify.report` document), the summary line on stderr.
- Inspector and VS Code panel: the `#cpg-verification` banner beside the graph; the graph is never shown without its verdict.
- VS Code: a status-bar glyph (worst state plus failing count) and a `DiagnosticCollection('cpg')` entry on each offending file, the only surface that localises to something a human can open.

## 4. The resolver verification harness (epic E-VERIFY, decision DQ-04)

The parse-and-resolve layer is the product and the most heavily instrumented part of the system. The harness lands at U6c and grows through U8 and U9. It is a standing capability, not a spike.

| component | what it measures | first version |
|---|---|---|
| golden corpus | per language, real repositories where every cross-file reference has a hand-verified or oracle-verified target; the thing that makes every later change safe | U6c: the two layered fixtures; grows to the S3 corpora (16k Python LOC, 9,077 ref sites) |
| precision and recall vs an oracle | the language server (basedpyright, later tsserver) run out of band as the oracle; **precision must be 0 disagreements** (the headless resolver is never wrong where it answers); recall reported per `RefKind` against the oracle's ceiling, with **separate denominators** for call/import and receiver/receiver-type | U6c |
| per-language ceilings | what *can* be resolved at all versus what we resolve; Python only until U9's spike; TypeScript never inherits Python's numbers | U6c / U9 |
| latency as a distribution | ms per ref site and per file, by file size and site count, over a **pipelined per-save loop against a warm document** (the one thing S3 did not measure); this re-cuts `perFileMs` and decides whether the 2 s promise is keepable | U6c (imports), U8 (calls) |
| degradation visibility | `degradedBatches`, `timedOutSites`, backend restarts as first-class report rows, never a flag nobody reads | U6c |

The harness runs locally (`npm run harness:resolve`) and nightly in CI. Its report is something the owner reads. If it shows the 2 s promise does not fit at p95 for a consumer set, the promise is restated per measured budget in `06-measurements.yaml` and the vision; it is never silently relaxed.

## 5. Per-milestone gates

Each row is the machine half; `07-milestones.yaml` carries the human artifact and the full list.

| unit | gate (machine) |
|---|---|
| U0 | CI green on ubuntu + macos; check-deps rejects planted `vscode` in `packages/**`, a planted host SDK in the wrong `apps/*`, and a deep import; no NUL bytes |
| U1 | model + ported schema tests green; C-MODEL and C-SINK suites green; schema drift check green; contracts-agree compiles; statement-level id round-trips |
| U2 | filesystem-reconciliation, id-uniqueness, revision-reconciliation pass on this repo; seeded layout byte-stable; the built bin executes; runtime purity proof green and its anti-vacuity run red; usage set-equals the flag table |
| U3 | U2 assertions inside the extension host; **empty diff under `packages/**`**; C-EXT suite green; E4 passes |
| U4 | C-WATCH suites green against parcel and the fake; digest set matches disk after quiescence; a create is never dropped; deletes absorb; three intervals on every batch; T2→T3 asserted in CI, T0→T3 a local benchmark |
| U5 | C-STORE suites green against Memory and Falkor; `statementCount === 1`; ~200 ms absolute ceiling; torn-batch test; read-back visible; no `DETACH DELETE`; adversarial values never reach cypher text |
| U6 | C-PARSE, C-EXTRACT, C-RESOLVE suites green; nodes/LOC ≤ 1.5; identity-invariants and resolution-health live; goldens incl. the insert-above case; coverage honest both ways |
| U7 | body edit → 0 cascade; interface edit → the asserted dependent set; over-budget → stale with reason; k=1/10/25 reconcile; first launch ≤ 10 min on the scale fixture |
| U8 | purity proof with the LSP link; precision 0; recall ≥ 95% of ceiling for receiver-type (EVAL_TYPE admission); per-save budget honoured; kill×3 → degraded surfaces in verify |
| U9 | spike report first with a pre-declared threshold; then the same invariants for TS |
| U10 | registered tool count ≤ 12; static manifest before attach; stdio hygiene; overlay never inside a replace; reserved names absent by default; ≥ 2 MCP hosts in CI |

## 6. CI rules (epic E-GATE)

Every rule below has been seen to fail on a planted violation, or is not a rule.

| rule | where | since |
|---|---|---|
| no host SDK import under `packages/**`; each `apps/*` imports only node builtins, `@cpg/*` front doors, and its own host SDK; no composition root under `packages/**` except `engine`; no deep import of another package's `dist`; no literal NUL byte | `tools/check-deps.mjs` (specifiers via `ts.preProcessFile` from U2c) + the gate-fails-when-violated job | U0 |
| runtime purity: the whole engine under plain `node` loads zero `vscode`/DOM/MCP-SDK modules; the anti-vacuity run plants an import and asserts the trap fires | `tools/purity-proof.mjs` | U2c |
| the built CLI binary executes: `--version` → 0, unknown verb → 2 | `tools/check-cli-bin.mjs` | U2a |
| usage text set-equals the flag table for every verb | vitest | U2a |
| schema drift: `04-schema.yaml`'s generated region equals code | `npm run schema:doc --check` | U1 |
| `receipt.statementCount === 1` for every replace-file | vitest (integration) | U5 |
| structural nodes/LOC ≤ 1.5 over the fixture corpus (per-file warning) | vitest | U6 |
| every archive coordinate cited in `docs/outline` resolves (`git rev-parse` the tag, `git cat-file -e` the path) | `tools/check-coordinates.mjs` | follow-up (12-retirement) |
| no live document cites a retired path (the list is defined in `12-retirement.md` §3 step 7, which is the only file exempt from the check) | `tools/check-citations.mjs` | follow-up |
| registered MCP tools ≤ 12 | vitest | U10 |
| reserved CFG/PDG/expression names never emitted by default | vitest | U10 |

**Local-only benchmarks (never CI gates, because a flaky gate gets disabled and a disabled gate is not a gate):** the atomic-replace latency band (p50 3–8 / p95 ≤ 16 ms), T0→T3 absolute latency, first-launch time, MemoryStore RSS. CI may assert *relative* regression on these against a checked-in baseline with a generous tolerance.

## 7. Test runners and conventions

- **vitest** for `packages/*` and `apps/cli`, `apps/inspector`, `apps/mcp`. Integration tests that need FalkorDB use the `cpg-test` compose project on 6381 and refuse a foreign instance three ways (nonce, args fingerprint, key prefix).
- **`@vscode/test-cli`** for `apps/vscode` host tests (this answers the retirement battery's question 21).
- **Conformance suites are parameterised** and run identically against every implementation and the in-repo fake: `verifyModelContract`, `verifyWatchBackendContract`/`verifyCoalesceContract`/`verifyBatchOrderContract`/`verifyWatchSessionContract`, `verifyParseContract`, `verifyExtractContract`, `verifyResolverContract`/`verifyChainContract`, `verifyGraphSinkContract`/`verifySinkDeliveryContract`, `verifyGraphStoreContract`/`verifyWritePlannerContract`, `verifyCliContract`, `verifyExtHostContract`/`verifyShellContract`. Each carries one test per named historical defect; deleting one means deleting its history.
- **Fakes are derived from the real adapter's declared type** and at least one test exercises the real shape (L-33). Injected clocks and sleeps mean zero real waits in unit tests.
- **Goldens** guard regressions and never stand in for human judgement (L-23). Golden regeneration runs locally and deliberately, never in CI.

## 8. Ground rules (GR1–GR6, carried)

1. One unit = one branch = one PR. Run the gate locally, see it green, then push. CI is a second opinion, not the first run.
2. The gate ships with the code. A PR that adds capability without its gate is not done.
3. 200–500 reviewable lines per PR, excluding generated snapshots and fixtures. Past that, it is two PRs.
4. Snapshot-changing PRs paste the diff and get explicit sign-off; goldens are regression protection, not the audit surface.
5. Manual gates are real gates: a story with a step only the owner can perform does not merge until it happens.
6. Spikes are units: a spike's pass/fail threshold is the gate of the unit it de-risks; there is no separate research backlog.
