# cpg-me-daddy — Project Outline

**Status:** authoritative as of 2026-09-17; U0 completed 2026-10-28 (foundation committed in `cfd080d`, finished on `feature/u0-finish`). Next: U1.
**Supersedes:** the earlier STATUS document, the unified-architecture plan, the current-target architecture review, the 2026-09-11 planning corpus, and the three decision-queue rounds. Those documents, and everything else that used to live beside this directory, are historical and are being retired to the `docs/archive` branch (see `12-retirement.md`). Do not cite them; if something you need is missing here, that is a defect in this directory, not a reason to reach back.

This directory is the whole plan. A developer who has never seen the project should be able to read it, pick a story from `07-milestones.yaml`, and start, knowing what is being built, why it is built this way, and how "done" is decided.

## The product in three sentences

`cpg` is a command-line tool that watches a codebase and maintains a **live, sparse, structural code graph**: which files and directories exist, what modules, classes, functions and calls they declare, and which code in one file refers to code in another. It stays fresh as you save, it is verifiable by machine, and every consumer of the graph is optional and switchable: a browser picture, a FalkorDB store you can query with Cypher, a VS Code panel, and later an MCP server for coding agents. The engine runs under plain `node` with zero editor dependency; the editor is one consumer among several, never the source of truth.

What v1 is **not**: a Joern-class Code Property Graph with control-flow and data-flow tiers. Those names are reserved in the schema and the design does not foreclose them, but v1 ships the structural tier only. `01-vision.md` says exactly what the graph can and cannot answer.

## Files

| file | what it is | read it when |
|---|---|---|
| `00-charter.md` | Why the project exists, who it is for, the five ranked constraints, the principles, what success means, how we work | first, always |
| `01-vision.md` | The product, the personas, the producer/consumer model, what v1 can and cannot answer, a primer on code property graphs, the north star | second |
| `02-decisions.yaml` | Every decision in force, one entry each, with rationale, consequences, what supersedes what, and what would reopen it | before proposing any change |
| `03-architecture.md` | Repository layout, the seven-stage pipeline, which stage owns which data, the seams, composition roots, configuration, CLI surface, the freshness clock | before writing code |
| `04-schema.yaml` | The graph vocabulary as data: 14 node labels, 15 edge types plus one reserved, properties, ownership classes, the id rule, enums, reserved names, rejections, evolution policy | before touching anything that produces or reads nodes |
| `05-contracts.yaml` | The nine seams as data: owning package, signatures, invariants, folded responsibilities, the cross-seam defects and their fixes | when implementing a stage or a seam |
| `06-measurements.yaml` | Every settled number with its conditions, what may no longer be argued, what is still unmeasured, absolutes that must never be re-quoted | before making a performance or sizing claim |
| `07-milestones.yaml` | Milestones U0–U10 → epics → features (PRs) → stories, each with gate, rollback, what it locks in, size, and where to port code from | to find your work |
| `08-verification.md` | Why the picture cannot verify correctness, `cpg verify` (six checks, four states), revision reconciliation, the resolver harness, per-milestone gates, CI rules | before declaring anything done |
| `09-glossary.md` | Terms used throughout | whenever a word is unfamiliar |
| `10-lessons.yaml` | The 48 lessons from two prior attempts and the 10 seam defects found in specification, each with the rule it implies and where it bites this plan | when a design choice looks arbitrary |
| `11-salvage.yaml` | Inventory of code on the archive tags worth porting, with exact coordinates, line counts, verdicts, target package and milestone | when a story says `port_from` |
| `12-retirement.md` | How the old documentation is neutralized, the disclaimer text, the citation gate, the 21-question battery that proves this directory is self-contained | when performing or auditing the archive |

## Reading order by role

**Junior developer joining to implement.** `00-charter.md` → `01-vision.md` → `03-architecture.md` → `07-milestones.yaml` (find your milestone and story) → the `port_from` rows of `11-salvage.yaml` for that story → `08-verification.md` for the gate you must pass → `09-glossary.md` as needed. Read `10-lessons.yaml` entries your story cites before you write code; each one is a bug somebody already paid for.

**Reviewer or maintainer.** `02-decisions.yaml` → `06-measurements.yaml` → `07-milestones.yaml`. A pull request that contradicts an in-force decision without a `reopen_when` trigger being met is not mergeable.

**Coding agent.** This file → `02-decisions.yaml` → `04-schema.yaml` → `05-contracts.yaml` → the story you are assigned. Never read anything on the `docs/archive` branch; it exists for humans researching history.

## How the files relate

```
00-charter ──constraints, principles──▶ 02-decisions ──▶ 03-architecture ──▶ 05-contracts
     │                                        │                │                  │
     │                                        ▼                ▼                  ▼
01-vision ──what v1 is──────────────▶ 04-schema ◀──── 07-milestones ◀──── 11-salvage
                                                             │
06-measurements ──numbers──▶ 08-verification ──gates──────────┘
10-lessons ──rules────────────▶ (every file cites L-nn / CS-nn where a choice is a scar)
```

Ids are stable and cross-referenced: decisions `DQ-nn`, `F-n`, `P-A/B/C`, `VD-nn`, `AM-n`, `DL-nn`, `ND-n`; lessons `L-nn`; seam defects `CS-nn`; contracts `C-NAME`; milestones `U0`–`U10`; epics `E-NAME`; features `Un.m`; stories `Un.m.k`; measurements `M-…`.

## Conventions

- **Archive coordinates.** Code from prior attempts is referenced as `archive/<lineage>-20260916:<path>` and read with `git show <tag>:<path>`. Line numbers appear only where a verbatim quote is pinned. Four archived files contain literal NUL bytes and are invisible to `grep`; use `grep -a` (they are named in `11-salvage.yaml`).
- **Paths in this directory.** Any statement about the current tree names the commit it describes. Anything that names a package path is a plan, not a fact, until `07-milestones.yaml` marks the story done.
- **Generated regions.** `04-schema.yaml` carries a generated region that milestone U1's schema generator regenerates from code; drift fails CI from U1 onward. Until U1 lands, it is hand-maintained and this file says so.
- **Numbers.** Every number in prose is a pointer into `06-measurements.yaml`, which carries the conditions under which it was measured. A number without a boundary is not a fact.

## How to change something

- **Add a property to a node or edge type:** free. Open a PR; the schema version bumps only if the property is required (`04-schema.yaml → evolution_policy`).
- **Add a node label or edge type:** free with one paragraph in `02-decisions.yaml` stating what question the graph can now answer that it could not before.
- **Rename, remove, or change the meaning of anything, or reverse a decision:** run the reopening test recorded on the decision's `reopen_when` field. State the premise that died, cite evidence dated after the decision, state what else breaks, and state the cost of keeping versus changing. Comparable costs means keep. Record the outcome as a new `ND-n` entry that supersedes the old one; never edit history.
- **Change a number:** measure it, record the boundary, and update `06-measurements.yaml` in the same PR. Add the old value to `never_requote` if it was ever cited.

## Working rules (short form; `00-charter.md` has the reasoning)

1. Order work by time to first human judgement, not by dependency depth.
2. The gate ships in the same PR as the code it gates. A gate nobody runs is a suggestion.
3. One unit, one branch, one PR, 200–500 reviewable lines. Run the gate locally first; CI is a second opinion.
4. Stub the whole shape first, compiling, with each body labeled REAL, PASSTHROUGH or SEAT; then make one piece real at a time.
5. START SIMPLE. Do not generalize before the second concrete caller exists.
6. The picture proves the system is alive. Code proves it is correct.
