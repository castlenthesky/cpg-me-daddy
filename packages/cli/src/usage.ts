export const USAGE = `cpg — Code Property Graph CLI

Usage:
  cpg index [--workspace <path>] [--include <glob>]... [--exclude <glob>]...
            [--dry-run] [--json] [--host <h>] [--port <n>] [--graph <name>]
  cpg query <cypher> [--json] [--host <h>] [--port <n>] [--graph <name>]
  cpg --version
  cpg --help

Commands:
  index   Walk a workspace, extract declarations, write them to FalkorDB.
  query   Run one read-only Cypher query against the indexed graph.

By default, both commands target the cpg-owned dev instance
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

export const QUERY_USAGE = `cpg query <cypher> [--json] [--host <h>] [--port <n>] [--graph <name>]

  <cypher>        The query to run, as a single argument (quote it).
  --json          Print the result rows as JSON instead of a table.
  --host <h>      FalkorDB host. Default: 127.0.0.1.
  --port <n>      FalkorDB port. Default: 6382 (the cpg dev instance).
  --graph <name>  Graph key. Default: cpg.`;
