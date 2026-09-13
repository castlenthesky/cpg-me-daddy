/**
 * The `cpg` command surface (M0.11-lite). `run` is the entire testable
 * surface — `main.ts` is a two-line shebang wrapper around it, so a test
 * drives real argument parsing and real command dispatch with no process
 * spawned and no `process.exit` anywhere near it.
 *
 * Exit codes: `0` success, `1` the operation failed (workspace unreadable,
 * DB unreachable, a query error), `2` a usage error (unknown command/flag,
 * missing required argument, a malformed `--port`).
 */
import { runIndex } from "./commands/index-cmd";
import { runQuery } from "./commands/query-cmd";
import { runWatch } from "./commands/watch-cmd";
import type { Io } from "./io";
import { USAGE } from "./usage";
import { CLI_VERSION, versionBanner } from "./version";

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.out(versionBanner());
    return 0;
  }

  switch (command) {
    case "index":
      return runIndex(rest, io);
    case "query":
      return runQuery(rest, io);
    case "watch":
      return runWatch(rest, io);
    default:
      io.err(`cpg: unknown command "${command}" (cpg@${CLI_VERSION}).`);
      io.err(USAGE);
      return 2;
  }
}
