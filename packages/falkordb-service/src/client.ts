/**
 * The connection. One `FalkorClient` owns one FalkorDB connection and one
 * graph handle, and reports the timing of everything that crosses it.
 *
 * This is deliberately thin: it speaks RESP and measures, and it has no
 * opinion about what the queries mean. The semantics live in the sub-services
 * under `services/`, which are handed a client rather than opening their own —
 * so a service is testable against a fake client, and a connection is opened
 * once and shared rather than once per concern.
 */

import { FalkorDB, type Graph } from "falkordb";

import type { FalkorConnectionConfig } from "./config";

/** A result set plus the two timings every query reports. */
export interface Timed<T = unknown> {
  data: T[];
  /** client-observed wall time, ms */
  wallMs: number;
  /** server-reported "Query internal execution time", ms (NaN if absent) */
  serverMs: number;
  /** raw metadata lines as FalkorDB returned them */
  meta: string[];
}

const EXEC_RE = /Query internal execution time:\s*([\d.]+)\s*milliseconds/;

/** Monotonic clock in fractional milliseconds. */
export function now(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export class FalkorClient {
  private constructor(
    readonly db: FalkorDB,
    readonly graph: Graph,
    readonly graphName: string,
    readonly timeoutMs: number,
  ) {}

  /**
   * Open a connection.
   *
   * Note the endpoint is passed in rather than read from config directly: in
   * `spawned` and `docker` modes the port is chosen by the OS at start time,
   * so the facade connects to the endpoint the server actually bound, not to
   * the configured one. See `ServerService.endpoint`.
   */
  static async connect(config: FalkorConnectionConfig): Promise<FalkorClient> {
    const db = await FalkorDB.connect({
      socket: { host: config.host, port: config.port },
      password: config.password,
    });
    return new FalkorClient(db, db.selectGraph(config.graph), config.graph, config.queryTimeoutMs);
  }

  /** Attach both timings to a raw driver result. */
  private wrap<T>(res: { data?: unknown; metadata: string[] }, t0: number): Timed<T> {
    const wallMs = now() - t0;
    let serverMs = Number.NaN;
    for (const m of res.metadata) {
      const mm = EXEC_RE.exec(m);
      if (mm?.[1] !== undefined) {
        serverMs = Number.parseFloat(mm[1]);
      }
    }
    return { data: (res.data ?? []) as T[], wallMs, serverMs, meta: res.metadata };
  }

  /** `GRAPH.QUERY` — the read/write path. */
  async query<T = unknown>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
    const t0 = now();
    const res = await this.graph.query<T>(query, {
      params: params as never,
      TIMEOUT: this.timeoutMs,
    });
    return this.wrap<T>(res as never, t0);
  }

  /**
   * `GRAPH.RO_QUERY` — the read path. FalkorDB rejects write clauses here
   * server-side ("graph.RO_QUERY is to be executed only on read-only
   * queries"), which makes read-only genuinely enforced rather than a
   * convention the caller is trusted to honour.
   */
  async roQuery<T = unknown>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
    const t0 = now();
    const res = await this.graph.roQuery<T>(query, {
      params: params as never,
      TIMEOUT: this.timeoutMs,
    });
    return this.wrap<T>(res as never, t0);
  }

  /**
   * `GRAPH.EXPLAIN` — a query plan, never executed. `GRAPH.EXPLAIN` has no
   * native parameter channel (unlike `GRAPH.QUERY`/`GRAPH.RO_QUERY`), and a
   * query referencing a runtime-only param like `$rows` (an `UNWIND`
   * source) plans fine without a value — but a param the PLANNER consumes
   * directly, such as an indexed property match `{file: $file}`, fails with
   * "Missing parameters" unless a value is supplied (verified live against
   * the pinned v4.20.4 image). So when `params` is given, this builds the
   * same `CYPHER key=value ... <query>` prefix `query()`/`roQuery()` build
   * via the driver's own (unexported) parameter serializer, reimplemented
   * here — `queryParamToString` below matches it exactly — and prepends it
   * before calling the read-only driver method that takes no params of its
   * own.
   */
  async explain(query: string, params?: Record<string, unknown>): Promise<string[]> {
    const text = params ? `CYPHER ${queryParamsToString(params)} ${query}` : query;
    const r: unknown = await this.graph.explain(text);
    return Array.isArray(r) ? r.map(String) : [String(r)];
  }

  /** Escape hatch for server commands the typed client does not model. */
  async raw<T = unknown>(args: string[]): Promise<T> {
    const conn = await this.db.connection;
    return (await conn.sendCommand(args)) as T;
  }

  /** Graph keys present on the whole instance, not just this client's graph. */
  async listGraphs(): Promise<string[]> {
    return this.db.list();
  }

  /** Drops this client's graph key. Tolerates the key not existing. */
  async dropGraph(): Promise<void> {
    try {
      await this.graph.delete();
    } catch {
      /* graph did not exist */
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * `CYPHER key1=value1 key2=value2 ...` — the exact prefix format the
 * `falkordb` driver itself builds internally for `query()`/`roQuery()`
 * (`queryParamsToString`/`queryParamToString` in its own
 * `commands/index.js`), reimplemented here because that module is internal
 * to the package and not part of its public exports. Kept in lockstep with
 * the upstream form: string quoting/escaping, numbers and booleans as-is,
 * arrays as `[...]`, plain objects as `{key:value,...}`. Exported (rather
 * than kept module-private) so its escaping edge cases have a DB-free unit
 * test of their own, not just incidental coverage from an `explain()` call
 * against a live server.
 */
export function queryParamsToString(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${queryParamToString(value)}`)
    .join(" ");
}

function queryParamToString(param: unknown): string {
  if (param === null) {
    return "null";
  }
  if (typeof param === "string") {
    return `"${param.replace(/["\\]/g, "\\$&")}"`;
  }
  if (typeof param === "number" || typeof param === "boolean") {
    return String(param);
  }
  if (Array.isArray(param)) {
    return `[${param.map(queryParamToString).join(",")}]`;
  }
  if (typeof param === "object") {
    const body = Object.entries(param as Record<string, unknown>).map(
      ([key, value]) => `${key}:${queryParamToString(value)}`,
    );
    return `{${body.join(",")}}`;
  }
  throw new TypeError(`Unexpected param type ${typeof param}: ${String(param)}`);
}
