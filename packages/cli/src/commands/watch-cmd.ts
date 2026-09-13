import { resolve } from "node:path";
/**
 * `cpg watch` — a headless run loop over `@cpg/engine`'s `watchWorkspace`:
 * an initial full filesystem-tier index, then live re-writes as files and
 * directories are added, removed, or moved on disk. The natural companion
 * to `cpg index` for iterating on the filesystem tier without relaunching
 * the VS Code extension host — re-query the graph (the FalkorDB Browser,
 * or `cpg query`) while this keeps it current.
 */
import { parseArgs } from "node:util";

import { defineCpgConfig, openCpgStore, watchWorkspace, type NormalizedChange } from "@cpg/engine";

import type { Io } from "../io";
import { WATCH_USAGE } from "../usage";

interface WatchArgs {
  readonly workspace: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly json: boolean;
  readonly skipInitialIndex: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly graph?: string;
}

class UsageError extends Error {}

function parseWatchArgs(argv: readonly string[]): WatchArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      workspace: { type: "string" },
      include: { type: "string", multiple: true, default: [] },
      exclude: { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
      "skip-initial-index": { type: "boolean", default: false },
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
    json: values.json ?? false,
    skipInitialIndex: values["skip-initial-index"] ?? false,
    host: values.host,
    port,
    graph: values.graph,
  };
}

function changeLine(change: NormalizedChange): string {
  const arrow = { created: "+", changed: "~", deleted: "-", moved: "→" }[change.kind];
  const what = change.entry === "directory" ? "dir " : "";
  const target =
    change.kind === "moved" && change.fromPath !== undefined
      ? `${change.fromPath} -> ${change.path}`
      : change.path;
  return `  ${arrow} ${what}${target}`;
}

/**
 * Resolves once a shutdown is requested — an injected `signal` (tests) or,
 * by default, this process's own SIGINT/SIGTERM (a real `cpg watch` run).
 * Never calls `process.exit`, matching this CLI's exit-code contract: the
 * caller returns a number, `main.ts` sets `process.exitCode`.
 */
function waitForShutdown(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal !== undefined) {
      if (signal.aborted) {
        resolvePromise();
        return;
      }
      signal.addEventListener("abort", () => resolvePromise(), { once: true });
      return;
    }
    const onSignal = (): void => resolvePromise();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

export async function runWatch(
  argv: readonly string[],
  io: Io,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<number> {
  let args: WatchArgs;
  try {
    args = parseWatchArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(WATCH_USAGE);
    return 2;
  }

  const config = defineCpgConfig({
    root: args.workspace,
    include: args.include.length > 0 ? args.include : undefined,
    excludeExtra: args.exclude,
    db: { connection: { host: args.host, port: args.port, graph: args.graph } },
    env: io.env,
  });

  let opened;
  try {
    opened = await openCpgStore(config.falkor);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const session = await watchWorkspace(
      config,
      { store: opened.store },
      {
        skipInitialIndex: args.skipInitialIndex,
        onReady: (report) => {
          if (args.json) {
            io.out(JSON.stringify({ kind: "ready", ...report }));
          } else {
            io.out(`cpg watch ${config.root}`);
            io.out(
              `  indexed ${report.filesIndexed} file(s), ${report.directoriesWritten} director${
                report.directoriesWritten === 1 ? "y" : "ies"
              }`,
            );
            io.out(
              `  watching for changes — graph "${config.falkor.connection.graph}" @ ` +
                `${config.falkor.connection.host}:${config.falkor.connection.port} (Ctrl-C to stop)`,
            );
          }
        },
        onBatch: (changes, write) => {
          if (args.json) {
            io.out(JSON.stringify({ kind: "batch", changes, write }));
            return;
          }
          const now = new Date().toISOString().slice(11, 19);
          io.out(`${now}  ${write.nodesWritten} node(s), ${write.edgesWritten} edge(s)`);
          for (const change of changes) {
            io.out(changeLine(change));
          }
        },
        onWarning: (message) => {
          io.err(args.json ? JSON.stringify({ kind: "warning", message }) : `warning: ${message}`);
        },
      },
    );

    await waitForShutdown(opts.signal);
    await session.close();
    if (!args.json) {
      io.out("cpg watch: stopped.");
    }
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await opened.close();
  }
}
