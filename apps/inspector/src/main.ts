#!/usr/bin/env node
// SEAT (U2b.1 part 3a-ii, BMO-35): the `cpg-inspector` bin, the one file that touches process. It
// takes no arguments (exit 2 and the stderr line
// `cpg-inspector: takes no arguments; it reads NDJSON on stdin`), serves dist/page/graph.js
// next to it, and assigns process.exitCode, never process.exit, so stdout drains: 0 once
// runInspector resolves, 1 with a `cpg-inspector: <message>` line when it rejects. bin.test.ts
// spawns it; like apps/cli/src/main.ts it is excluded from coverage.

throw new Error('SEAT: the cpg-inspector bin is U2b.1 part 3a-ii');
