/**
 * Typed wrapper over FalkorDB's `GRAPH.QUERY` / `GRAPH.RO_QUERY`.
 *
 * Ported from ast-demo/bench/src/client.ts, where it was the benchmark's
 * measurement surface. Here it is the engine's only door to the graph, so the
 * timing that used to feed a benchmark report now feeds the budget gates
 * (VS4) instead — every call still carries both the client-observed wall time
 * and the server's own "Query internal execution time".
 *
 * Engine purity: this file, like everything under packages/engine, must never
 * import `vscode`. It speaks RESP and nothing else.
 */

import { FalkorDB, type Graph } from "falkordb";

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

/** Where to reach a FalkorDB instance, and how long to let a query run. */
export interface ClientConfig {
  host: string;
  port: number;
  password?: string;
  /** Graph key. Every query this client issues is scoped to it. */
  graph: string;
  /** Per-query server-side timeout, ms. */
  queryTimeoutMs: number;
}

const EXEC_RE = /Query internal execution time:\s*([\d.]+)\s*milliseconds/;

/** Monotonic clock in fractional milliseconds. */
export function now(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export class Client {
  private constructor(
    readonly db: FalkorDB,
    readonly graph: Graph,
    readonly graphName: string,
    private readonly timeoutMs: number,
  ) {}

  static async connect(cfg: ClientConfig): Promise<Client> {
    const db = await FalkorDB.connect({
      socket: { host: cfg.host, port: cfg.port },
      password: cfg.password,
    });
    return new Client(db, db.selectGraph(cfg.graph), cfg.graph, cfg.queryTimeoutMs);
  }

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
  async write<T = unknown>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
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
  async read<T = unknown>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
    const t0 = now();
    const res = await this.graph.roQuery<T>(query, {
      params: params as never,
      TIMEOUT: this.timeoutMs,
    });
    return this.wrap<T>(res as never, t0);
  }

  /** Scalar helper for `RETURN count(...)`-style reads. */
  async scalar(query: string, params?: Record<string, unknown>): Promise<number> {
    const r = await this.read<Record<string, number>>(query, params);
    const row = r.data[0];
    if (!row) {
      return 0;
    }
    const v = Object.values(row)[0];
    return typeof v === "number" ? v : Number(v);
  }

  /** Escape hatch for server commands the typed client does not model. */
  async raw<T = unknown>(args: string[]): Promise<T> {
    const conn = await this.db.connection;
    return (await conn.sendCommand(args)) as T;
  }

  async explain(query: string): Promise<string[]> {
    const r: unknown = await this.graph.explain(query);
    return Array.isArray(r) ? r.map(String) : [String(r)];
  }

  /** Graph keys present on the whole instance, not just this client's graph. */
  async listGraphs(): Promise<string[]> {
    return this.db.list();
  }

  /**
   * `GRAPH.CONFIG GET *` flattened to a plain record of stringified values.
   *
   * v4.20.4 answers with `[[key, value], ...]`; older servers answer with a
   * flat `[key, value, key, value, ...]`. Both are accepted so a version bump
   * cannot turn this into a silently-empty record — which, since the test
   * harness fingerprints the instance from it, would turn an identity check
   * into a no-op.
   */
  async configSnapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const r = await this.raw<unknown[]>(["GRAPH.CONFIG", "GET", "*"]);
    if (r.length > 0 && Array.isArray(r[0])) {
      for (const kv of r as unknown[][]) {
        if (kv.length === 2) {
          out[String(kv[0])] = String(kv[1]);
        }
      }
      return out;
    }
    for (let i = 0; i + 1 < r.length; i += 2) {
      out[String(r[i])] = String(r[i + 1]);
    }
    return out;
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
