#!/usr/bin/env node
// Structural sparsity gate (C-EXTRACT I15 and Q6; U6a.3 "CI asserts structural nodes/LOC <= 1.5 over
// the fixture corpus"; controller decision 101).
// Usage: node tools/check-sparsity.mjs [corpus] [--report <cpg.index.report.json>]
//
// The corpus defaults to the repository's fixtures/ladder; a given one is resolved against the cwd.
// Either way `<corpus>` below is that absolute path. Without --report the tool builds apps/cli (`tsc -b`, a no-op
// when current) and runs the built bin the way an installed `cpg` runs:
// `node apps/cli/dist/main.js index <corpus> --dry-run --format json`, cwd the repository, with this
// process's environment (so CPG_GRAMMAR_DIR reaches it). `--report <file>` reads that document from
// the file instead and runs nothing (a test seam).
//
// - Adapter files: the report body's files whose path ends with one of ADAPTER_EXTENSIONS (`.py`
//   until U6b). Their structural nodes are `nodes` (the engine never asks for the expression tier).
//   Every other file is ignored.
// - LOC per adapter file, read from `<corpus>/<path>` with the engine's rule: 0 for an empty file,
//   else `text.split('\n').length` of its UTF-8 text.
// - Density is nodes / LOC, printed with 3 decimals (`toFixed(3)`); nodes over 0 LOC is Infinity.
// - Failures, each one line on stderr, then exit 1:
//   - `check-sparsity: cpg index failed (exit <n>): <its stderr>` when the bin exits non-zero, and
//     `check-sparsity: no cpg.index.report document` when its stdout (or the --report file) is not
//     one JSON document of kind cpg.index.report;
//   - `check-sparsity: <corpus>: no adapter files` when there are none;
//   - `check-sparsity: <corpus>/<path>: no code-tier nodes` for each adapter file with 0 nodes (a
//     code tier that never ran would otherwise pass);
//   - `check-sparsity: <corpus>: structural density <d> n/LOC is over the bar 1.5` when
//     sum(nodes) / sum(LOC) over the adapter files is over BAR (1.5).
// - Per adapter file with LOC > 0 and nodes / LOC over BAR: `check-sparsity: warning: <path> <d>
//   n/LOC` on stderr, never a failure (Q6: a generated file must not train people to disable it).
// - stderr order: the warnings in the report's file order, then the failures in the order above
//   (the no-code-tier-nodes lines in the report's file order).
// - On success, one line on stdout:
//   `check-sparsity: <nodes> nodes / <loc> LOC = <d> n/LOC over <files> files (bar 1.5)`.
//
// SEAT (U6a.3-2 RED): the gate lands with the implementation.

console.error('check-sparsity: SEAT: the sparsity gate lands in U6a.3-2');
process.exit(1);
