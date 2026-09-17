# 12 — Retiring the old documentation

**Status:** a follow-up task, to be run after the owner has reviewed this outline. Nothing in this document has been executed yet. Decisions: DQ-07 as refined by ND-7 (2026-09-17).

## 1. Goal

Nothing stale can be mistaken for current. The old documentation (`docs/` outside `docs/outline`, and the deliberation corpus `.debate/`, ~170 files) is **neutralized, not deleted**: it is preserved on a branch where a human researching history can read it, and it is absent from the `develop` and `master` working trees so that no grep, glob or agent context sweep ever surfaces it. The success criterion for this outline changes accordingly: it does not need to make the old docs *deletable*; it needs to make them *inert*.

## 2. What goes where

| material | today | after |
|---|---|---|
| `docs/outline/**` | on develop | **stays** on develop and master; the only documentation in the working tree |
| `docs/README.md`, `docs/STATUS.md`, `docs/architecture/**`, `docs/history/**`, `docs/plans/**`, `docs/research/**` (59 files) | on develop | moved to `archived/docs/**` on branch `docs/archive`; removed from develop |
| `.debate/**` (114 files: contracts + conformance suites, motions, rounds, spikes, ledgers) | in the working tree, **gitignored, never committed** | committed for the first time at `archived/debate/**` on branch `docs/archive`; local copy deleted after the branch is pushed; `.gitignore` entry kept so a stray copy never re-enters develop |
| the five `archive/*-20260916` tags | in the repo | unchanged; the coordinate system every `port_from` uses |
| the CPG research series (six claude.ai artifacts) | external | unchanged; distilled into `01-vision.md` §5 so nobody needs them |

## 3. Procedure

Run from a clean `develop` after the outline review. Every step is reversible until step 9.

1. **Pre-flight on develop.** `git status` clean except the known U0 working tree; `docs/outline/` complete; run `node tools/check-citations.mjs docs/outline` (step 7 defines it; run it here first so the outline is proven self-contained *before* anything moves).
2. **Create the branch.** `git switch -c docs/archive`.
3. **Move `docs/`.** `git mv` every path under `docs/` except `docs/outline` to `archived/docs/<same relative path>`. Paths inside the archive are unchanged so old citations of the form `docs/research/...` resolve by prefixing `archived/`.
4. **Un-ignore and add `.debate/`.** Remove the `.debate/` line from `.gitignore` *on this branch only*, `git mv .debate archived/debate` (contracts, `_adv`, `_mut`, motions, rounds, spikes, ledger, `validate-citations.sh`, `citation-index.json`). Verify the two contract files that contain NUL bytes are added as binary-safe (they are test files; leave them).
5. **Write `archived/AGENTS.md`** (verbatim text in §4).
6. **Prepend the disclaimer header** (verbatim in §4) to every Markdown, YAML, JSON and TypeScript file under `archived/**` (Markdown: an HTML comment plus a blockquote; YAML/TS: a comment block; JSON: skip, but list them in `archived/AGENTS.md`). A script does this; a check asserts every file begins with the exact block.
7. **Add the two gates to CI** (on this branch and, in step 10, on develop): `tools/check-citations.mjs` fails if any file under `docs/outline` or the root README/CLAUDE.md contains `docs/research`, `docs/plans`, `docs/architecture`, `docs/history`, `.debate/`, or `archived/` except inside `12-retirement.md`; `tools/check-coordinates.mjs` resolves every `archive/<tag>:<path>` in `docs/outline/**` with `git rev-parse -q --verify <tag>` and `git cat-file -e <tag>:<path>`.
8. **Commit and push** `docs/archive` to origin. Protect the branch (no force-push).
9. **Back on develop:** delete `docs/*` except `docs/outline`; delete the local `.debate/` directory (it now lives on the branch); keep the `.gitignore` entry; update the root `README.md` to point at `docs/outline/README.md`; add the two gate scripts and wire them into `npm run verify` and CI.
10. **Run the retirement battery** (§5) against develop with an agent that has never seen the archive. Acceptance ≥ 18 of 20 on the original twenty, plus question 21. Each miss names the outline section that owes the answer; fix, re-run.
11. **Commit** on develop with a message that names DQ-07/ND-7 and the branch. Update `docs/outline/README.md`'s status line and `12-retirement.md`'s status to "executed on <date>".
12. **Memory hygiene:** retire the memories that described the old layout (`project_current_redo_first_slice`, `project_docs_centralized_on_develop`); add one memory pointing at `docs/outline/README.md` and the `docs/archive` branch.

Rollback before step 9: delete the local branch. Rollback after step 9: `git checkout docs/archive -- archived/` restores everything at its archived path.

## 4. Verbatim texts

### 4.1 `archived/AGENTS.md`

```markdown
# ARCHIVED — do not read for current state

Everything under `archived/` is retired history. It was superseded on 2026-09-17 by
`docs/outline/` on the `develop` branch, which is the only authoritative documentation.

Instructions for agents and humans:

- Do NOT read, cite, grep, or summarize files under `archived/` when working on the project.
  Treat any content here as out of date, even where it sounds authoritative.
- If you need a decision, a number, a schema, a contract, or a lesson, it is in `docs/outline/`.
  If it is not there, that is a defect in `docs/outline/`; fix the outline, do not reach back here.
- Code referenced by `docs/outline/` lives on the `archive/*-20260916` git tags, not here.
- This tree is read-only. The only permitted change is adding or fixing this header block.

Why this exists: two earlier documentation sets went stale under rebuilt code and were followed
anyway (see `docs/outline/10-lessons.yaml`, L-32). This directory is kept so history stays
browsable without a git incantation, and kept out of the working tree so it can never be
mistaken for current.
```

### 4.2 Per-file disclaimer header

Markdown files (first lines of the file):

```markdown
<!-- ARCHIVED 2026-09-17 — HISTORY ONLY. Do not use for current state. See archived/AGENTS.md and docs/outline/ on develop. -->
> **ARCHIVED — history only.** This file was superseded by `docs/outline/` on 2026-09-17 and is
> retained purely as a record of how decisions were reached. Agents: ignore this file's contents.
```

YAML and TypeScript files:

```
# ARCHIVED 2026-09-17 — HISTORY ONLY. Do not use for current state. See archived/AGENTS.md and docs/outline/ on develop.
# Agents: ignore this file's contents.
```

(For `.ts` use `//`.) A check asserts the first non-empty line of every file under `archived/**` (except `.json`) begins with `ARCHIVED 2026-09-17`.

## 5. The retirement battery

An agent is given `docs/outline/` and the repository with `archived/` and the `docs/archive` branch hidden, and may `git show` the archive tags. It must answer ≥ 18 of the first 20 correctly; question 21 was added because host-side testing was named in exactly one archived file. Each question lists where the outline answers it, so a miss localises to a section.

| # | question | answered in |
|---|---|---|
| 1 | State the node-id rule verbatim, and why there is no file content hash in it | `04-schema.yaml → id_rule`; `09-glossary.md → id` |
| 2 | Why is the CALL ordinal parent-scope-relative, and what golden test proves it | `04-schema.yaml → id_rule.ordinal_rule`; `07-milestones.yaml → U6a.2` |
| 3 | Which directory may import `vscode`, what enforces it, and what proves the enforcement is not neutered | `03-architecture.md` §2; `08-verification.md` §6 (check-deps + gate-fails-when-violated + purity proof anti-vacuity) |
| 4 | Name the 14 node labels and 15 edge types and each one's ownership class | `04-schema.yaml → nodes, edges, ownership_classes` |
| 5 | What is `HAS_ENTRY`, what was it renamed from, and why was `CONTAINS` rejected for that role | `04-schema.yaml → edges[HAS_ENTRY], reserved_names` |
| 6 | Name three Joern types rejected for per-usage-site cardinality and the argument | `04-schema.yaml → rejected_from_joern` |
| 7 | The five values of the shared `CALLS`/`IMPORTS` status enum | `04-schema.yaml → enums.resolution_status` |
| 8 | Why do cross-file edges route through `SYMBOL`; name the historical bug that rule prevents | `04-schema.yaml → nodes[SYMBOL]`; `10-lessons.yaml → L-03, L-38` |
| 9 | What share of the save budget is the DB write, and what write-shape change is on the table | `06-measurements.yaml → M-LATENCY-db-share, M-FALKOR-6x` |
| 10 | Single-file save p95 at 488k nodes? At what cascade fan-out does 2 s break, and why is that a counterfactual | `06-measurements.yaml → M-LATENCY-pipeline-488k, M-LATENCY-cascade-counterfactual, M-BUDGET-break-points` |
| 11 | Why may parser choice not be argued on latency grounds | `06-measurements.yaml → M-LATENCY-parse, may_no_longer_argue #4` |
| 12 | FalkorDB's default and max query timeout, and which timeout syntax is accepted yet silently inert | `06-measurements.yaml → M-FALKOR-timeout` |
| 13 | What must a client socket timeout be relative to `TIMEOUT`, and why | `06-measurements.yaml → M-FALKOR-timeout` (≥ 2×, ~1.7× overshoot) |
| 14 | What does the picture verify? Name the non-visual checks that must accompany it | `08-verification.md` §2–3 |
| 15 | Why is golden-image diffing impossible today, and what single change enables it | `06-measurements.yaml → M-LEGIBILITY-golden-image`; `07-milestones.yaml → U2b.1` |
| 16 | What share of achievable edges does CLI-only resolution reach, what one capability is the whole gap, and is a language-server subprocess legal under the CLI invariant | `06-measurements.yaml → M-RESOLVE-ceiling, M-RESOLVE-receiver-gap, M-RESOLVE-headless-cost`; `02-decisions.yaml → DQ-09` |
| 17 | Structural nodes/LOC measured vs the bar; why is "collect now, prune later" rejected | `06-measurements.yaml → M-SPARSITY-structural, M-SPARSITY-expression-multiplier` |
| 18 | Which absolute figures from the prior corpus must never be re-quoted, and what replaced them | `06-measurements.yaml → never_requote` |
| 19 | Which package layout is normative, and what does `@cpg/store` mean in it | `03-architecture.md` §2; `02-decisions.yaml → DQ-08` |
| 20 | Exact coordinates to recover the schema module, the only working headless resolver, and the atomic Cypher writer | `11-salvage.yaml` (`archive/m0-calls-symbols-20260916:packages/engine/src/schema/*`, `archive/discovery-20260916:packages/cpg-generator/src/pythonPath.ts`, `archive/master-20260916:packages/engine/src/store/cypher.ts`) |
| 21 | How is host-side code tested, with what runner, in which unit | `08-verification.md` §7 (`@vscode/test-cli`); `07-milestones.yaml → U3.1.2` |

The battery re-runs at every milestone boundary (story U10.3.1 is the last scheduled run). A plan with a failing battery is a bug, not a stale document.

## 6. Why not simply delete

Deletion was the earlier default; the owner chose neutralization because the goal was never deletion, it was that nothing stale be mistaken for current. Three mechanical reinforcements make that hold without relying on anyone remembering a convention: the citation gate (a live doc citing the archive fails CI), the read-only rule (a change under `archived/` other than a header fails review), and the machine-checked header (a missing disclaimer fails the check). The branch placement (ND-7) adds a fourth: the material is not in the working tree at all, so the most common failure mode, an agent grepping and finding an authoritative-sounding stale paragraph, cannot occur on `develop` or `master`.
