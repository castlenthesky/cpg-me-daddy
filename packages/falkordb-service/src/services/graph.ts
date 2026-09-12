/**
 * Queries against one graph key.
 *
 * Takes a `FalkorClient` rather than a config: the connection is built once by
 * the facade and injected here, so this service can be exercised against a
 * fake client with no server anywhere in sight.
 */

import type { FalkorClient, Timed } from "../client";

export class GraphService {
  constructor(private readonly client: FalkorClient) {}

  /** The graph key every query below is scoped to. */
  get name(): string {
    return this.client.graphName;
  }

  /** `GRAPH.QUERY` — the read/write path. */
  async write<T = unknown>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
    return this.client.query<T>(query, params);
  }

  /** `GRAPH.RO_QUERY` — the read path, with write clauses refused server-side. */
  async read<T = unknown>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
    return this.client.roQuery<T>(query, params);
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

  /** Query plan, as FalkorDB renders it. */
  async explain(query: string): Promise<string[]> {
    return this.client.explain(query);
  }
}
