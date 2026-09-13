#!/usr/bin/env node
import { processIo } from "./io";
/** The actual `bin` entry. All real logic lives in `run.ts` — this is a shebang wrapper. */
import { run } from "./run";

run(process.argv.slice(2), processIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `cpg: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
