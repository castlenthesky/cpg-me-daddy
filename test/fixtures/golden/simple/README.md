# Golden simple tests

Minimal, hand-auditable source + CPG pairs used as the smoke contract for
AST → sparse CPG extraction (M0.6–M0.10). These do **not** replace the
layered fixtures under `test/fixtures/code_examples/` — those remain the
larger M0.5 / M0.11 oracle.

Each language directory holds:

- `hello_world.{py,ts}` — the source under test
- `hello_world.cpg.json` — the expected per-file `GraphDelta` (schema v2)

Data flow is in scope: `MEMBER -[:REACHING_DEF {variable}]-> CALL`.
Expression-tier nodes (`LOCAL` / `IDENTIFIER` / `LITERAL`) are not.
