# 01 — Product Vision

## 1. The product

**`cpg` keeps a live structural graph of your codebase and lets you, your editor, your database and your agents ask it questions.**

Install the CLI. Run `cpg index .` and you have a graph of your repository: every directory and file, every module, class, function, parameter and member they declare, every call and import, and, across files, which call reaches which definition. Run `cpg watch .` and the graph stays current as you save. Turn on the consumers you want:

| consumer | what it gives you | switch |
|---|---|---|
| in-memory store | always on; the producer's own working copy | none |
| browser inspector | a picture of the graph that updates live; proves the system is alive | `--inspect` |
| FalkorDB | a persistent, Cypher-queryable copy, written atomically per file; agents and humans query it with `cpg query` or any Redis client | `--store falkor` |
| VS Code panel | the same picture inside the editor, with click-to-source; the extension is the producer launched with this consumer enabled | install the extension |
| MCP server | ≤12 read-only tools for coding agents: find a symbol, callers, callees, impact of a change, path between two points, graph status | `cpg mcp` (U10) |

Everything above the first row is optional. A terminal-only developer who wants raw throughput runs the producer alone and pays for nothing else. That is the design's centre of gravity (principle P-A), and it is why the engine is a set of host-free packages and the editor is one front door among several.

## 2. Personas

**The terminal developer.** Lives in a shell and an editor that is not VS Code, or no editor at all. Wants `cpg index`, `cpg verify`, `cpg query`, and a graph they can trust in CI. For them the CLI is the whole product. Constraint 1 exists for them.

**The VS Code developer.** Wants to see the graph next to their code, click a node and land on the declaration, and watch the picture change as they save. They get the same producer with the panel consumer switched on. They never get a richer graph than the terminal developer: the graph's contents do not depend on which editor window is open (decision DQ-09).

**The coding agent.** Runs where VS Code is not open. Needs small, fast, ranked structural answers before editing: "who depends on this, transitively, and what will break." Gets them through the MCP consumer reading the store, with every result carrying explicit freshness so it knows what to trust and what to retry.

## 3. How a save becomes a graph

```
file changes on disk
   → WATCH      notices, debounces, batches; mints the file's revision_id (content hash)
   → PARSE      builds a syntax tree (tree-sitter, wasm)
   → EXTRACT    pulls out declarations, calls, imports — one node per thing you would name, never per token
   → RESOLVE    works out what refers to what, across files, through SYMBOL identity nodes
   → SINK       delivers the change as one numbered delta to every enabled consumer
   → STORE      persists it: memory always, FalkorDB as one atomic statement per file
   → surfaces   inspector, VS Code panel, MCP
```

Each arrow is a **seam**: a boundary with a contract (`05-contracts.yaml`). Every defect found while specifying this pipeline was at a seam, none inside a stage, and both prior attempts died at seams. So every stage owns named data and is forbidden to touch the rest (`03-architecture.md` §4).

## 4. What v1 can and cannot answer

**Can.** Containment of files, modules, classes and functions. Who calls whom across files, with a five-value status on every call so recall is inspectable, not hidden. Who imports what, at 100% of the achievable ceiling. Callers-of and callees-of at declaration granularity. Declaration-level dead code. File-level import cycles. Fan-in and fan-out. Intra-file: which member or parameter definition reaches a call site. Whether any node is stale relative to its file, by query.

**Cannot.** What executes before or after a statement (no control-flow graph). Whether a branch is dead (no control dependence). What value a variable holds (no expression tier). Whether attacker input reaches a sink (no taint). Any cross-file data flow. Any flow-sensitive question.

**Honest scope statement, to appear in the README:** *a fresh, sparse, structural cross-file call-and-import graph, visible and queryable within 2 seconds of a save.* It is aligned to Joern's vocabulary so that the flow tiers can be added later without renaming anything, but it is not a code property graph in Joern's sense today. Until the headless Python resolver lands (U8), it also cannot claim full call recall: the CLI-only resolver reaches about a third of achievable call edges, and the whole gap is one capability, receiver type inference (`06-measurements.yaml → resolution`).

## 5. A primer on code property graphs, and where this product sits

This section exists so a reader never needs the six-chapter research series the project drew on. Every claim below cites a primary source; the series is listed at the end as further reading.

### 5.1 Code is a byte string; structure is manufactured

Source code as any tool receives it is a one-dimensional byte string. A five-line Python function is about a hundred bytes, a quarter of them the spaces a reader perceives as shape. The lexer turns bytes into tokens and, in Python, manufactures `INDENT`/`DEDENT` tokens nobody typed. The parser applies a grammar and produces a tree. Tree-sitter, the parser under most modern editors, produces a concrete syntax tree with a node for every token including punctuation, and traversing only its named nodes behaves like an abstract syntax tree [1][2]. Some tools keep everything for round-tripping (rust-analyzer's lossless Rowan trees [3]); some throw formatting away on purpose (Prettier "only prints code. It does not transform it" [4]). Compilers, formatters, transpilers and linters are all well served by a tree, and most of the tooling industry stopped there.

### 5.2 A tree has no clock and no plumbing

A syntax tree records what the code is written to be. It has no notion of time: an `if` has two children, but the tree does not say that exactly one runs. It has no notion of plumbing: nothing connects the assignment to `user` on one line with the read of `user` forty lines away. And it has no notion of which body a call reaches: `conn.execute(q)` is one `CALL` node, and whether `conn` is Postgres, Mongo or a test mock is a question about data flowing through time.

The founding CPG paper measured the cost. Yamaguchi and colleagues took 88 Linux kernel vulnerabilities from 69 CVEs, sorted them into twelve types, and asked which could be modeled with syntax alone. The answer was one: insecure arguments to sensitive functions. Every other type needed execution order, data flow, or both [6].

### 5.3 What a code property graph is

A property graph is a directed, edge-labeled, attributed multigraph. A **code property graph** is what you get by merging a program's abstract syntax tree, control-flow graph and program dependence graph at their statement and predicate nodes. The AST is the only one of the three that introduces nodes; the CFG and PDG contribute edges and nothing else [6]. Joern is the open-source reference platform; its specification is published and this project's schema is aligned to its vocabulary where the names overlap [20]. The 2014 paper put the whole Linux kernel, 52 million nodes and 87 million edges, into a graph database on a laptop and found 18 previously unknown vulnerabilities with queries that ran in under 40 seconds [6].

Two things follow for a design like this one. First, the graph is expensive to build and cheap to ask; everything since 2014 is an argument about how much of the build can be avoided when one file changes. Second, a full AST-level graph is roughly 40 nodes and 67 edges per line of C; a statement-level schema with the tree folded into node attributes cuts that by more than ten times [19]. This product goes further and stores one node per named thing, which is why its measured density is 0.36–0.43 nodes per line.

### 5.4 What line-oriented tools actually catch

Tools that stop at syntax miss most real vulnerabilities, and the measurements agree. Seven free SAST tools including CodeQL and Semgrep detected 12.7% of real-world Java vulnerabilities; combined, 70.9% remained undetected [10]. On production code, individual tools detected 11.2–26.5%, four together 38.8%, and simply reconfiguring Semgrep's rules lifted it alone to 44.7% [11]. The lesson is not that nobody does data flow: CodeQL stores the syntax tree, control-flow graph and data-flow graph of every file [13], and Semgrep tracks taint across files in its paid tier [14]. The lesson is that **the graph is the substrate and the queries are the product**, and each incumbent's graph is a closed box you query on the tool's terms. An open, queryable, cross-layer graph is the case for building one in a graph database.

### 5.5 Incremental update is the least-solved part

Per-file layers are cheap to keep fresh: tree-sitter's incremental reparse shares structure with the old tree [28]; GitHub's stack graphs indexed every file in isolation [29]; SCIP is a per-document index by construction [30]. Cross-file derived facts are the hard half. Meta's Glean aims at O(changes) but "in practice the best we can do is O(fanout)", because every fact derived from a changed file must be re-derived [32], under the invariant that a derived fact is visible only if everything it was derived from is visible [33]. None of the systems surveyed incrementally maintains interprocedural data-flow facts across edits.

This is why the schema marks every edge type as file-owned (a file change deletes and rebuilds it along with the file's subgraph) or overlay/identity (recomputed for the fan-out and nothing more), why cross-file edges route through `SYMBOL` identity nodes that a per-file replace never touches, and why cascade is bounded by an interface hash rather than left open. A study of five open-source code-graph tools found that four of five resolve cross-file identity with a whole-corpus relink on every run and none is incremental at the graph-write level. Near-live per-file update is the differentiator to defend, not a feature to catch up on (`10-lessons.yaml` L-46, L-47).

### 5.6 What agents need from a graph

The working systems that give language models code context hand the model small, fast, structural answers rather than a database connection. Aider ranks a tree-sitter definition/reference graph with PageRank and fits it into about a thousand tokens; structural chunking at syntactic boundaries improves retrieval by a few points; the load-bearing part of the best graph-guided detection pipeline is a model that writes the query and a second that reads the slice. An agent that can ask "what breaks if I change this" and get a ranked list in a millisecond is more useful than one that can write any traversal and wait for it. This is why the MCP consumer exposes at most twelve named tools with raw Cypher listed last, and why it reads through the store rather than through the producer.

### 5.7 Where this product sits, and what stays open

| tier | v1 | later | how the door stays open |
|---|---|---|---|
| filesystem (DIRECTORY, FILE, HAS_ENTRY) | ✔ | | |
| structural declarations (MODULE, TYPE_DECL, METHOD, PARAM, MEMBER) | ✔ | | |
| calls and imports with resolution status (CALL, IMPORT, CALLS, IMPORTS) | ✔ | | |
| cross-file identity (SYMBOL, DEFINES, ALIAS_OF, INHERITS_FROM) | ✔ | | |
| sparse data flow (`REACHING_DEF` MEMBER/PARAM → CALL, intra-file) | ✔ | widen | same edge type, wider endpoints |
| receiver-type calls (`EVAL_TYPE`) | reserved | U8, gated ≥95% of ceiling | name and shape reserved in the schema with `producer: none-yet` |
| analytics overlay (COMMUNITY, TARGETS, DEPENDS_ON, MEMBER_OF) | U10 | | |
| control flow, dominators, control dependence | ✗ | north star | Joern names reserved; `CONTAINS` held unclaimed; statement-level id slot tested |
| expression tier (IDENTIFIER, LITERAL, LOCAL) | ✗ | on demand only | extractor emits a `tier` discriminator so an expression pass is additive |
| taint (sources, sinks, sanitizers, findings) | ✗ | north star | per-call-site annotation slot on `TAGGED_BY` reserved |
| persisted labels, layer rules, agent write-back | ✗ | north star | MCP stays read-only; graph stays a cache |

### 5.8 Sources

1. Tree-sitter contributors. *Basic Parsing: concrete syntax trees, named and anonymous nodes.* https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html
2. Brunsfeld, M. et al. *Tree-sitter: Introduction.* https://tree-sitter.github.io/tree-sitter/
3. rust-analyzer team. *Syntax: rust-analyzer architecture.* https://rust-analyzer.github.io/book/contributing/syntax.html
4. Prettier project. *Rationale.* https://prettier.io/docs/rationale
6. Yamaguchi, F., Golde, N., Arp, D., Rieck, K. (2014). *Modeling and Discovering Vulnerabilities with Code Property Graphs.* IEEE S&P. https://mlsec.org/docs/2014-ieeesp.pdf
10. Li, K. et al. (2023). *Comparison and Evaluation on Static Application Security Testing (SAST) Tools for Java.* ESEC/FSE. doi:10.1145/3611643.3616262
11. Bennett, G., Hall, T., Winter, E., Counsell, S. (2024). *Semgrep\*: Improving the Limited Performance of SAST Tools.* EASE. doi:10.1145/3661167.3661262
13. GitHub. *About CodeQL.* https://codeql.github.com/docs/codeql-overview/about-codeql/
14. Semgrep. *Taint mode: track data flow.* https://docs.semgrep.dev/writing-rules/data-flow/taint-mode/overview
18. Reps, T. (1998). *Program analysis via graph reachability.* Information and Software Technology 40(11–12). doi:10.1016/S0950-5849(98)00093-7
19. Deng, X. et al. (2025). *Code Property Graph Meets Typestate.* IEEE ICSME. https://zhengyaoliu.com/papers/ICSME2025.pdf
20. Joern project. *Code Property Graph Specification 1.1.* https://cpg.joern.io/
28. Tree-sitter contributors. *Advanced parsing: editing and incremental reparse.* https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html
29. GitHub. *Introducing stack graphs.* https://github.blog/2021-12-09-introducing-stack-graphs/
30. Sourcegraph / SCIP Core Steering Committee. *SCIP Code Intelligence Protocol.* https://github.com/scip-code/scip
32. Meta Engineering (2024). *Glean: open source code indexing.* https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/
33. Meta. *Glean: incrementality.* https://glean.software/docs/implementation/incrementality/

Further reading: the six-chapter series *Stacking the Sheets* (Flat String Illusion; Three Transparent Sheets; Text to Graph; Paths and Slices; Shape of the City; Viability Verdict), from which this primer is distilled. It is not required to work on this project.

## 6. North star

Candidate themes, none committed. Each stays possible because of a specific reservation in the v1 design; none may be started without a decision entry.

- **Agent as collaborator:** pre-flight impact analysis before an edit; the graph as a guardrail that can veto; context packs; memory bound to symbols rather than files.
- **Time:** graph history per commit; PR review mode with a structural risk score; architectural health trends.
- **Runtime overlays:** traces, profiles and coverage projected onto the graph; incident stack traces mapped to code paths; test impact analysis.
- **Beyond source:** cross-boundary edges (frontend fetch → route handler, ORM → tables, OpenAPI, queues, infrastructure as code); multi-repo federation; SBOM and CVE reachability.
- **Quality:** refactor plans rather than smells; ArchUnit-style fitness functions as zero-row Cypher constraints in CI; classic coupling and instability metrics; near-duplicate and dead-export detection.
- **Human surfaces:** inline hints ("used by 42 callers"); live C4 diagrams; natural language to view; onboarding tours.
- **Reach:** more languages; SQL, GraphQL and Protobuf as first-class; other editors; a plugin API and rule packs; exports to SCIP, LSIF and Joern.

Three recorded tensions to resolve before any of these: read-only MCP versus agent write-back; privacy versus team sharing; a sparse graph versus runtime and history data.
