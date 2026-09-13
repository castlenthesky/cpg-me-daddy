/**
 * Goes from a resolved `FalkorConfig` to a connected, bootstrapped
 * `FalkorGraphStore` — the wiring `FalkorService.start()` + `new
 * FalkorGraphStore(...)` that, until M0.1-thin/M0.11-lite, every call site in
 * this repo was a test. `cpg index`, the extension's index command, and
 * `cpg query` all go through this, so the wiring exists exactly once.
 */
import {
  FalkorService,
  isServerError,
  ServerError,
  type FalkorConfig,
  type FalkorServiceDeps,
} from "falkordb-service";

import type { BootstrapReport } from "./bootstrap";
import { FalkorGraphStore } from "./falkordb-store";
import type { IGraphStore } from "./store";

// Re-exported so a caller (the CLI, the extension) can recognize a
// connection failure and surface its `remedy` without a direct dependency
// on falkordb-service — engine purity is about imports, not runtime, and
// packages/vscode already depends only on @cpg/engine.
export { isServerError, ServerError };

/** The port the integration harness owns. See `CLAUDE.md` and `test/support/falkordb.ts`. */
export const TEST_HARNESS_PORT = 6381;

/** Every graph key the integration harness's own tests are allowed to touch. */
export const TEST_HARNESS_GRAPH_PREFIX = "cpg_test_";

/**
 * Refuses to proceed against the integration harness. That harness hard-
 * errors on any graph key not prefixed `cpg_test_` from its own side
 * (`test/support/falkordb.ts`) — this is the mirror image, on the write
 * side: nothing today stopped `cpg index` from running `bootstrapSchema()`
 * and per-file replaces against it before that check ever got a chance to
 * fire. No env escape hatch, on purpose.
 */
export function assertNotTestHarness(config: FalkorConfig): void {
  if (config.connection.port === TEST_HARNESS_PORT) {
    throw new Error(
      `Refusing to open a store on port ${TEST_HARNESS_PORT}: that is the integration test ` +
        "harness (docker/falkordb.yml), not a database for real data. Use the cpg-owned dev " +
        "instance instead (`bun run db:dev:up`, port 6382) — see CLAUDE.md.",
    );
  }
  if (config.connection.graph.startsWith(TEST_HARNESS_GRAPH_PREFIX)) {
    throw new Error(
      `Refusing to open a store on graph "${config.connection.graph}": the ` +
        `"${TEST_HARNESS_GRAPH_PREFIX}" prefix is reserved for the integration test harness.`,
    );
  }
}

export interface OpenStoreOptions {
  /** Runs `store.bootstrap()` before returning. Default `true`. */
  readonly bootstrap?: boolean;
  /** Injected in tests to run against a fake connection. */
  readonly deps?: FalkorServiceDeps;
}

export interface OpenedStore {
  readonly store: IGraphStore;
  /**
   * `IGraphStore` deliberately has no `read()` (see `store.ts`'s module doc);
   * `cpg query` and anything else that needs to read the graph uses this
   * instead, rather than widening the store seam.
   */
  readonly graph: FalkorService["graph"];
  readonly falkor: FalkorService;
  readonly bootstrapReport: BootstrapReport | undefined;
  close(): Promise<void>;
}

/**
 * Connects to `config`, wires a `FalkorGraphStore`, and (by default)
 * bootstraps the schema. Always refuses the integration harness first.
 */
export async function openCpgStore(
  config: FalkorConfig,
  options: OpenStoreOptions = {},
): Promise<OpenedStore> {
  assertNotTestHarness(config);

  const falkor = await FalkorService.start(config, options.deps);
  try {
    // A graph key does not exist on FalkorDB until something writes to it —
    // any read against a missing key (including `bootstrapSchema`'s own
    // `CALL db.indexes()`) fails with "Invalid graph operation on empty
    // key". `RETURN 1` materializes the key with no nodes, the same
    // workaround `test/support/falkordb.ts`'s `openTestGraph` already uses
    // for the exact same reason.
    await falkor.graph.write("RETURN 1");

    const store = new FalkorGraphStore({
      graph: falkor.graph,
      admin: falkor.admin,
      close: () => falkor.close(),
    });
    const bootstrapReport = (options.bootstrap ?? true) ? await store.bootstrap() : undefined;
    return {
      store,
      graph: falkor.graph,
      falkor,
      bootstrapReport,
      close: () => falkor.close(),
    };
  } catch (error) {
    // A connection we opened and could not finish wiring is a leak, not a
    // partial result — mirrors FalkorService.start's own failure handling.
    await falkor.close();
    throw error;
  }
}
