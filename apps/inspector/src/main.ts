#!/usr/bin/env node
// REAL (U2b.1 part 3a-ii, BMO-35): the `cpg-inspector` bin, the one file that touches process. It
// takes no arguments (exit 2 and the stderr line
// `cpg-inspector: takes no arguments; it reads NDJSON on stdin`), serves dist/page/graph.js
// next to it, and assigns process.exitCode, never process.exit, so stdout drains: 0 once
// runInspector resolves, 1 with a `cpg-inspector: <message>` line when it rejects. bin.test.ts
// spawns it; like apps/cli/src/main.ts it is excluded from coverage.

import { join } from 'node:path';
import { runInspector } from './inspector';

if (process.argv.length > 2) {
  process.stderr.write('cpg-inspector: takes no arguments; it reads NDJSON on stdin\n');
  process.exitCode = 2;
} else {
  void runInspector({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    bundlePath: join(__dirname, 'page', 'graph.js'),
  }).then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`cpg-inspector: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
