# The ladder

Thirteen tiny workspaces, each one concept bigger than the last. Each rung's graph is small enough to check by eye against its source. A rung's `expected.cpg` was written by hand from `ws/` and the schema (`docs/outline/04-schema.yaml`). It was never captured from cpg output.

Use it bottom up. When a stage lands, run it on rung 00 and compare. Climb one rung at a time. When a rung disagrees, the bug is in the one concept that rung added.

| rung                | adds                                                                       | stages it can check           |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| 00-one-text-file    | DIRECTORY, FILE, HAS_ENTRY; a file no grammar claims                       | walker                        |
| 01-empty-module     | MODULE, SOURCE_FILE                                                        | parse, extract                |
| 02-one-function     | METHOD, DECLARES, the first SYMBOL                                         | extract                       |
| 03-params           | PARAM, HAS_PARAM, a default value                                          | extract                       |
| 04-local-call       | CALL, IN_SCOPE, same-file CALLS; two identical calls told apart by ordinal | extract, resolve (same file)  |
| 05-class            | TYPE_DECL, MEMBER, a method inside a type                                  | extract                       |
| 06-import           | two files, IMPORT, cross-file IMPORTS and CALLS through SYMBOL             | resolve (imports)             |
| 07-package          | a subdirectory, dotted module names, a dotted import                       | walker, resolve (imports)     |
| 08-receiver-call    | a call whose target needs the receiver's type                              | resolve (language server, U8) |
| 09-syntax-error     | a file with a syntax error                                                 | parse                         |
| 10-ts-import        | rung 06 in TypeScript                                                      | parse, extract, resolve       |
| 11-ts-receiver-call | rung 08 in TypeScript; `new`                                               | resolve (language server, U9) |
| 12-tsx-routing      | the same JSX under `.tsx` and `.ts`                                        | parse                         |

## Layout

```
NN-name/
  ws/             the workspace root; every path in expected.cpg is relative to it
  expected.cpg    the hand-derived answer
```

## expected.cpg

One fact per line. A `#` that begins a line or follows a space starts a comment. A `#` inside a word is part of it, as in the SCIP fqn `` `main.py`/Greeter#greet(). ``. A section header names the pipeline stage that owns the facts under it, so a stage is checked against its own sections only.

| section        | owner                                      | holds                                                                                                                   |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `[parse]`      | PARSE                                      | one line per file: `PARSE <path> language=<id> root=<type> hasError=<bool>`, or `SKIP <path>` when no grammar claims it |
| `[filesystem]` | the walker (WATCH tier)                    | DIRECTORY, FILE, HAS_ENTRY                                                                                              |
| `[structural]` | EXTRACT, plus SOURCE_FILE from the indexer | file-owned nodes and the edges between them                                                                             |
| `[symbols]`    | EXTRACT                                    | DEFINES edges; each target is the SYMBOL it mints                                                                       |
| `[resolution]` | RESOLVE                                    | CALLS and IMPORTS with `status`                                                                                         |

A node line is `LABEL <id> key=value ...`. An edge line is `TYPE <from> -> <to> key=value ...`. An endpoint is a node id (`makeNodeId` form) or a SYMBOL fqn (SCIP descriptor, backtick-quoted path).

Values are raw text with no spaces. The schema gives each property its type. `null` is the absent value and `[a,b]` is a list.

A line asserts its id, its label, and exactly the properties it lists. A property left out is not checked. The facts are a set, so line order carries no meaning.

Ranges are `startLine:startCol-endLine:endCol`, with 1-based lines, 0-based UTF-16 columns and an exclusive end. A MODULE spans the whole file including its last newline, so a two-line file ends at `3:0` and an empty file is `1:0-1:0`.

## Checking a rung by hand

1. Read `ws/`.
2. Read `expected.cpg` one section at a time and find each line's construct in the source.
3. Count the columns of one `range` per rung.

`packages/model/src/ladder.test.ts` checks that every line speaks the schema. It checks that every label, edge type and property exists, that every id round-trips through `parseNodeId`, that every edge's endpoint labels are allowed, and that every endpoint is declared in the same rung. It cannot check that a line is true. A person reading the source checks that.

## The expected answer is the truth, not a milestone

Every line states what is true of the source, including facts no stage produces yet. Rung 08's receiver call needs a type-aware resolver (U8), so a resolver that declines it is incomplete, not wrong. A stage that emits a line the file does not hold is wrong. Precision is checked against every line, and recall is reported per stage.

A language server is the independent oracle for `[resolution]`. `bun run ladder:oracle [rung...]` asks basedpyright and tsserver about every CALL and IMPORT, maps each answer to the SYMBOL its declaration DEFINES, and reports agree, DISAGREE, unanswered or missing per site. It exits 1 on DISAGREE or missing. It spawns two servers, so `bun run check` does not run it. Run it whenever a rung's `[resolution]` changes. In the 2026-11-22 spike, basedpyright answered every Python call and import site in rungs 04, 06, 07 and 08 at the definition `expected.cpg` names. tsserver did the same for rungs 10 and 11, but only after its project load finished. Before that it named the local import binding, a plausible wrong answer.

## Open questions

A line tagged `# ?Qn` is a judgment call the plan does not settle yet. Each tagged line is the author's best reading, and the owner's ruling replaces it. Q1 to Q3 and Q5 are ruled (controller decisions 90 to 92 and 95, owner delegation, 2026-11-26), and their tags are gone.

- **Q1, ruled.** A MODULE mints a SYMBOL whose fqn is its path with no descriptor, `` `main.py`/ ``, and DEFINES it from the MODULE (decision 90). A whole-module import needs it as a target.
- **Q2, ruled.** A PARAM mints no SYMBOL in v1 (decision 91): AM-5 bans local symbols, and a parameter is local in most SCIP indexers. `DEFINES` still allows PARAM as a source; removing that endpoint is the owner's call.
- **Q3, ruled.** The CALL ordinal counts every call in its region, in pre-order (an outer call before the calls in its arguments, then source order), and the region is the enclosing METHOD, or `$root` at module level. IMPORT ordinals count the same way (decision 92). Inserting an unrelated statement above rung 04's two calls changes no id. Inserting a call above them renumbers both, as intended.
- **Q4.** Does a constructor call resolve to the class (`Greeter#`) or to its initializer? basedpyright and tsserver both answer with the class.
- **Q5, ruled.** For a region with a syntax error the extractor emits the declarations tree-sitter recovered (decision 95). An ERROR node is not descended; each ERROR node directly under a container gets one `UNKNOWN` with `reason=syntax-error`. A class's header counts as directly under it, so an ERROR there is an `UNKNOWN` in the class's scope (decision 117). A compound statement (`if`, `for`, `while`, `try`, `with`, `match`) at module or class level is not a scope: its blocks' statements and its other parts are its container's children, so an ERROR among them is the container's `UNKNOWN` (stop-list 196). A file whose root is itself an ERROR is a MODULE spanning the file plus one `UNKNOWN` for the root (decision 116). Rung 09's code-tier sections were written by hand from its source.
- **Q6.** For `export function f()`, does `range` span the `export_statement` or the `function_declaration` inside it?

## Not on the ladder yet

Decorators, `REACHING_DEF`, `INHERITS_FROM`, star and re-exported imports, import cycles, external and builtin targets (`print`), and edits between two revisions of a rung. Each one is a later rung, added when the stage that owns it lands. Nested named declarations (a `def` or `class` inside a function body) are not descended in v1 (decision 92), so no rung shows them.
