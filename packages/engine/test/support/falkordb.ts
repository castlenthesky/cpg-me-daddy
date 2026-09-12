/**
 * Integration-test harness for FalkorDB (F2).
 *
 * Two jobs:
 *
 * 1. **Isolation.** Every test gets its own graph key, so tests that run
 *    concurrently cannot see or clobber each other's data, and each drops its
 *    key on the way out.
 *
 * 2. **Refusing a foreign instance.** This is the part that is easy to get
 *    wrong and expensive when you do. `docker compose up` can fail with "port
 *    is already allocated" while `PING` on that same port still answers —
 *    because a *different* container already owns it. A harness that only
 *    checks "did something answer?" then happily runs its suite against a
 *    colleague's dev database, passes, and leaves test nodes behind. So before
 *    the first test runs we make the instance prove it is ours, three ways:
 *
 *      a. **Provenance nonce** (strongest, local only). `scripts/falkordb-up.ts`
 *         writes a random nonce into the container over the container's *own*
 *         loopback via `docker exec`, then records it in .tmp/. If reading that
 *         key back over the published TCP port returns the same nonce, the port
 *         demonstrably routes to the container we started. Nothing else can
 *         fake it.
 *      b. **Config fingerprint.** The instance must report the exact
 *         FALKORDB_ARGS from docker/falkordb.yml. These are far from FalkorDB's
 *         defaults, so a stock instance fails. (Not sufficient alone: a sibling
 *         harness copied from the same benchmark has the same args — which is
 *         exactly the case on the machine this was written on. Hence (a) and (c).)
 *      c. **Graph-key hygiene.** Every graph key already on the instance must
 *         carry our prefix. One graph named anything else means real data lives
 *         here and we must not touch it.
 *
 * Any of the three failing is a hard, loud error. There is no "something
 * answered, good enough" path.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { FalkorService } from "../../../falkordb-service/src/index.ts";
import { defineCpgFalkorConfig } from "../../src/store/falkordb.config.ts";

/** Graph keys the harness owns. Anything else on the instance is foreign. */
export const HARNESS_GRAPH_PREFIX = "cpg_test_";

/** Must match docker/falkordb.yml's FALKORDB_ARGS exactly. */
export const HARNESS_GRAPH_CONFIG: Readonly<Record<string, string>> = {
  TIMEOUT_DEFAULT: "30000",
  TIMEOUT_MAX: "60000",
  CACHE_SIZE: "200",
  NODE_CREATION_BUFFER: "65536",
};

/** Key that scripts/falkordb-up.ts stamps with the provenance nonce. */
export const HARNESS_NONCE_KEY = "cpg:harness:instance";

const INSTANCE_FILE = ".tmp/falkordb-instance.json";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6381;
const QUERY_TIMEOUT_MS = 30_000;

const REMEDIATION =
  "Start the harness instance with `bun run db:up` (docker compose -f docker/falkordb.yml up -d) " +
  "and stop any other server holding the port. Never point the harness at a database you care about.";

export interface HarnessTarget {
  host: string;
  port: number;
  password: string | undefined;
}

/** Where the harness expects its instance. Overridable for CI or a spare port. */
export function harnessTarget(): HarnessTarget {
  return {
    host: process.env.CPG_TEST_FALKORDB_HOST ?? DEFAULT_HOST,
    port: Number(process.env.CPG_TEST_FALKORDB_PORT ?? DEFAULT_PORT),
    password: process.env.CPG_TEST_FALKORDB_PASSWORD,
  };
}

/** Walks up from cwd to the workspace root (the directory holding bun.lock). */
function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "bun.lock"))) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) {
      return process.cwd();
    }
    dir = up;
  }
}

function readRecordedNonce(): string | undefined {
  const path = process.env.CPG_TEST_FALKORDB_INSTANCE_FILE ?? join(repoRoot(), INSTANCE_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const nonce = (raw as { nonce?: unknown }).nonce;
  return typeof nonce === "string" && nonce.length > 0 ? nonce : undefined;
}

async function verifyInstance(falkor: FalkorService, target: HarnessTarget): Promise<void> {
  const where = `${target.host}:${target.port}`;

  // (a) provenance nonce — proves this TCP port reaches the container we started.
  const expected = readRecordedNonce();
  if (expected !== undefined) {
    const actual = await falkor.admin.raw<string | null>(["GET", HARNESS_NONCE_KEY]);
    if (actual !== expected) {
      throw new Error(
        `Refusing to run: the FalkorDB at ${where} is NOT the instance this harness started.\n` +
          `  ${HARNESS_NONCE_KEY} is ${actual === null ? "unset" : `"${actual}"`}, expected "${expected}".\n` +
          `  Something else is bound to port ${target.port} — note that \`docker compose up\` can fail with\n` +
          `  "port is already allocated" while PING on that port still answers, from the other container.\n` +
          `  ${REMEDIATION}`,
      );
    }
  }

  // (b) config fingerprint — a stock or differently-tuned instance fails here.
  const config = await falkor.admin.configSnapshot();
  const wrong: string[] = [];
  for (const [key, want] of Object.entries(HARNESS_GRAPH_CONFIG)) {
    const got = config[key];
    if (got !== want) {
      wrong.push(`${key}=${got ?? "<absent>"} (expected ${want})`);
    }
  }
  if (wrong.length > 0) {
    throw new Error(
      `Refusing to run: the FalkorDB at ${where} does not carry this harness's configuration.\n` +
        wrong.map((w) => `  - ${w}`).join("\n") +
        `\n  That is somebody else's server, not the one docker/falkordb.yml defines.\n  ${REMEDIATION}`,
    );
  }

  // (c) graph-key hygiene — refuse an instance that already holds real data.
  const graphs = await falkor.admin.listGraphs();
  const foreign = graphs.filter((g) => !g.startsWith(HARNESS_GRAPH_PREFIX));
  if (foreign.length > 0) {
    throw new Error(
      `Refusing to run: the FalkorDB at ${where} holds ${foreign.length} graph(s) this harness does not own: ` +
        `${foreign.slice(0, 10).join(", ")}.\n` +
        `  The harness only ever creates keys prefixed "${HARNESS_GRAPH_PREFIX}", so this instance is in use\n` +
        `  by something else and running here would pollute it.\n  ${REMEDIATION}`,
    );
  }
}

let verified: Promise<void> | undefined;

/**
 * Verifies the instance once per process. Memoized on the promise, so parallel
 * first calls share one check, and a failure is re-thrown to every caller
 * rather than letting the second test through.
 */
async function ensureVerified(target: HarnessTarget): Promise<void> {
  verified ??= (async () => {
    let guard: FalkorService;
    try {
      guard = await FalkorService.start(harnessConfig(target, `${HARNESS_GRAPH_PREFIX}guard`));
    } catch (e) {
      // Nothing is listening, or it refused us. Say what to do rather than
      // leaving a bare ECONNREFUSED for the reader to interpret.
      throw new Error(
        `Cannot reach a FalkorDB at ${target.host}:${target.port}: ${e instanceof Error ? e.message : String(e)}\n` +
          `  ${REMEDIATION}`,
        { cause: e },
      );
    }
    try {
      await verifyInstance(guard, target);
    } finally {
      await guard.close();
    }
  })();
  await verified;
}

/**
 * The harness connects to a FalkorDB that `bun run db:up` already started, so
 * it is `remote` mode: the service checks reachability and owns no lifecycle.
 * Everything else — the CPG_ env prefix, the cpg-branded remedies — comes from
 * `defineCpgFalkorConfig`, so the harness exercises the same configuration
 * path the product does.
 */
function harnessConfig(target: HarnessTarget, graph: string) {
  return defineCpgFalkorConfig({
    server: { mode: "remote" },
    connection: {
      host: target.host,
      port: target.port,
      password: target.password,
      graph,
      queryTimeoutMs: QUERY_TIMEOUT_MS,
    },
  });
}

/** A test's private graph, and the teardown that removes it. */
export interface TestGraph {
  falkor: FalkorService;
  /** The isolated graph key. Unique per call. */
  key: string;
  /** Drops the graph key and closes the connection. Safe to call twice. */
  close(): Promise<void>;
}

function uniqueKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${HARNESS_GRAPH_PREFIX}${slug || "test"}_${suffix}`;
}

/**
 * Opens an isolated graph for one test. Verifies the instance is ours before
 * the first connection, so a misdirected suite fails on its first test with a
 * clear message instead of quietly writing into a stranger's database.
 */
export async function openTestGraph(label: string): Promise<TestGraph> {
  const target = harnessTarget();
  await ensureVerified(target);

  const key = uniqueKey(label);
  const falkor = await FalkorService.start(harnessConfig(target, key));

  // A graph key does not exist until something writes to it, and FalkorDB
  // answers any read against a missing key with "Invalid graph operation on
  // empty key". A test that reads before it writes would fail on that instead
  // of on its own assertion, so materialize the key up front: `RETURN 1`
  // creates it with no nodes, which is exactly the empty-but-present state a
  // test expects to start from.
  await falkor.graph.write("RETURN 1");

  let closed = false;
  return {
    falkor,
    key,
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await falkor.admin.dropGraph();
      await falkor.close();
    },
  };
}
