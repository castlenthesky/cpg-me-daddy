/** `cpg query "<cypher>"` — a thin read-only surface over `GraphService.read()`. */
import { parseArgs } from "node:util";

import { defineCpgConfig, openCpgStore } from "@cpg/engine";

import type { Io } from "../io";
import { QUERY_USAGE } from "../usage";

interface QueryArgs {
  readonly cypher: string;
  readonly json: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly graph?: string;
}

class UsageError extends Error {}

function parseQueryArgs(argv: readonly string[]): QueryArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      json: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      graph: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const cypher = positionals[0];
  if (cypher === undefined || positionals.length > 1) {
    throw new UsageError(
      "cpg query needs exactly one <cypher> argument — quote it if it has spaces.",
    );
  }

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number.parseInt(values.port, 10);
    if (!Number.isFinite(port)) {
      throw new UsageError(`--port must be an integer, got "${values.port}".`);
    }
  }

  return { cypher, json: values.json ?? false, host: values.host, port, graph: values.graph };
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A minimal column-aligned table — no dependency, this is the only place it's needed. */
export function formatTable(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return "(0 rows)";
  }
  const columns = Object.keys(rows[0]!);
  const cells = rows.map((row) => columns.map((c) => formatCell(row[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i]!.length)));
  const line = (values: readonly string[]) => values.map((v, i) => v.padEnd(widths[i]!)).join("  ");
  return [line(columns), ...cells.map(line)].join("\n");
}

export async function runQuery(argv: readonly string[], io: Io): Promise<number> {
  let args: QueryArgs;
  try {
    args = parseQueryArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(QUERY_USAGE);
    return 2;
  }

  const config = defineCpgConfig({
    db: { connection: { host: args.host, port: args.port, graph: args.graph } },
    env: io.env,
  });

  let opened;
  try {
    opened = await openCpgStore(config.falkor, { bootstrap: false });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const result = await opened.graph.read<Record<string, unknown>>(args.cypher);
    if (args.json) {
      io.out(JSON.stringify(result.data, null, 2));
    } else {
      io.out(formatTable(result.data));
    }
    io.err(`-- ${result.data.length} row(s) in ${result.wallMs.toFixed(1)}ms`);
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await opened.close();
  }
}
