export const USAGE = `cpg — Code Property Graph CLI

Usage:
  cpg index [--workspace <path>] [--include <glob>]... [--exclude <glob>]...
            [--dry-run] [--json] [--host <h>] [--port <n>] [--graph <name>]
  cpg watch [--workspace <path>] [--include <glob>]... [--exclude <glob>]...
            [--skip-initial-index] [--json] [--host <h>] [--port <n>] [--graph <name>]
  cpg query <cypher> [--json] [--host <h>] [--port <n>] [--graph <name>]
  cpg --version
  cpg --help

Commands:
  index   Walk a workspace, extract declarations, write them to FalkorDB.
  watch   Index once, then keep the graph's filesystem tier current as
          files and directories are added, removed, or moved. Ctrl-C to stop.
  query   Run one read-only Cypher query against the indexed graph.

By default, all three commands target the cpg-owned dev instance
(127.0.0.1:6382, started with \`bun run db:dev:up\`) — never
127.0.0.1:6381, the integration test harness.`;

export const INDEX_USAGE = `cpg index [--workspace <path>] [--include <glob>]... [--exclude <glob>]...
          [--dry-run] [--json] [--host <h>] [--port <n>] [--graph <name>]

  --workspace <path>  Directory to index. Default: the current directory.
  --include <glob>    Repeatable. Replaces the default include set.
  --exclude <glob>    Repeatable. Added to the default exclude set.
  --dry-run           Walk and parse, but write nothing — no DB required.
  --json              Print the full report as JSON.
  --host <h>          FalkorDB host. Default: 127.0.0.1.
  --port <n>          FalkorDB port. Default: 6382 (the cpg dev instance).
  --graph <name>      Graph key. Default: cpg.`;

export const WATCH_USAGE = `cpg watch [--workspace <path>] [--include <glob>]... [--exclude <glob>]...
          [--skip-initial-index] [--json] [--host <h>] [--port <n>] [--graph <name>]

  --workspace <path>     Directory to watch. Default: the current directory.
  --include <glob>       Repeatable. Replaces the default include set.
  --exclude <glob>       Repeatable. Added to the default exclude set.
  --skip-initial-index   Assume the graph's filesystem tier is already current — skip
                         the initial full walk-and-write, go straight to watching.
  --json                 Print one JSON object per line (NDJSON) instead of text.
  --host <h>             FalkorDB host. Default: 127.0.0.1.
  --port <n>             FalkorDB port. Default: 6382 (the cpg dev instance).
  --graph <name>         Graph key. Default: cpg.

  Runs until interrupted (Ctrl-C / SIGTERM), then closes cleanly and exits 0.`;

export const QUERY_USAGE = `cpg query <cypher> [--json] [--host <h>] [--port <n>] [--graph <name>]

  <cypher>        The query to run, as a single argument (quote it).
  --json          Print the result rows as JSON instead of a table.
  --host <h>      FalkorDB host. Default: 127.0.0.1.
  --port <n>      FalkorDB port. Default: 6382 (the cpg dev instance).
  --graph <name>  Graph key. Default: cpg.`;
