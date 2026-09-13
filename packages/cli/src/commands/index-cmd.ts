import { resolve } from "node:path";
/**
 * `cpg index` — the M0.11-lite CLI surface over `@cpg/engine`'s
 * `indexWorkspace`. This file owns argument parsing and output formatting
 * only; the pipeline itself lives entirely in the engine (`indexer/index-workspace.ts`)
 * so the extension's future index command can call the same function.
 */
import { parseArgs } from "node:util";

import {
  defineCpgConfig,
  indexWorkspace,
  openCpgStore,
  WebTreeSitterBackend,
  type BootstrapReport,
  type GraphDelta,
  type GraphMetadata,
  type IGraphStore,
  type WriteReport,
} from "@cpg/engine";

import type { Io } from "../io";
import { INDEX_USAGE } from "../usage";

interface IndexArgs {
  readonly workspace: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly graph?: string;
}

class UsageError extends Error {}

function parseIndexArgs(argv: readonly string[]): IndexArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      workspace: { type: "string" },
      include: { type: "string", multiple: true, default: [] },
      exclude: { type: "string", multiple: true, default: [] },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      graph: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number.parseInt(values.port, 10);
    if (!Number.isFinite(port)) {
      throw new UsageError(`--port must be an integer, got "${values.port}".`);
    }
  }

  return {
    workspace: resolve(values.workspace ?? process.cwd()),
    include: values.include ?? [],
    exclude: values.exclude ?? [],
    dryRun: values["dry-run"] ?? false,
    json: values.json ?? false,
    host: values.host,
    port,
    graph: values.graph,
  };
}

/** Counts what a real write would, but persists nothing — `--dry-run`'s DB. */
class NullGraphStore implements IGraphStore {
  async bootstrap(): Promise<BootstrapReport> {
    return {
      indexesCreated: [],
      indexesExisting: [],
      constraintsCreated: [],
      constraintsExisting: [],
      schemaVersion: { expected: 0, found: undefined, action: "created" },
    };
  }

  async writeDelta(delta: GraphDelta): Promise<WriteReport> {
    return { nodesWritten: delta.nodes.length, edgesWritten: delta.edges.length, opsExecuted: 0 };
  }

  async deleteFile(): Promise<void> {}

  async readMetadata(): Promise<GraphMetadata | undefined> {
    return undefined;
  }

  async close(): Promise<void> {}
}

export async function runIndex(argv: readonly string[], io: Io): Promise<number> {
  let args: IndexArgs;
  try {
    args = parseIndexArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(INDEX_USAGE);
    return 2;
  }

  const config = defineCpgConfig({
    root: args.workspace,
    include: args.include.length > 0 ? args.include : undefined,
    excludeExtra: args.exclude,
    db: { connection: { host: args.host, port: args.port, graph: args.graph } },
    env: io.env,
  });

  const backend = new WebTreeSitterBackend();
  const store = args.dryRun ? new NullGraphStore() : undefined;

  try {
    const opened = store === undefined ? await openCpgStore(config.falkor) : undefined;
    try {
      const report = await indexWorkspace(config, {
        store: store ?? opened!.store,
        backend,
      });

      if (args.json) {
        io.out(JSON.stringify(report, null, 2));
      } else {
        io.out(`cpg index ${config.root}`);
        io.out(
          `  walked ${report.walk.filesSeen} candidate file(s) (${report.walk.filesExcluded} excluded, ` +
            `${report.walk.filesUnsupported} unsupported, ${report.walk.filesTooLarge} too large)`,
        );
        io.out(
          `  indexed ${report.filesIndexed} file(s) · ${report.nodesWritten} nodes · ` +
            `${report.edgesWritten} edges  (${(report.durationMs / 1000).toFixed(1)}s)`,
        );
        for (const w of report.warnings) {
          io.out(`  skipped: ${w.message}`);
        }
        if (!args.dryRun) {
          io.out(
            `  graph "${config.falkor.connection.graph}" @ ${config.falkor.connection.host}:${config.falkor.connection.port}`,
          );
        } else {
          io.out("  (--dry-run: nothing was written)");
        }
      }

      return 0;
    } finally {
      await opened?.close();
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    backend.dispose();
  }
}
