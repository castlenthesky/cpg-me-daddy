/**
 * Instance-level operations: what graphs exist, how the server is configured,
 * and dropping a graph key.
 *
 * These are deliberately kept off `GraphService`. Everything here reaches past
 * the one graph the client is scoped to and speaks to the whole instance,
 * which is a different blast radius and worth a different object.
 */

import type { FalkorClient } from "../client";

export class AdminService {
  constructor(private readonly client: FalkorClient) {}

  /** Graph keys present on the whole instance, not just the client's graph. */
  async listGraphs(): Promise<string[]> {
    return this.client.listGraphs();
  }

  /**
   * `GRAPH.CONFIG GET *` flattened to a plain record of stringified values.
   *
   * v4.20.4 answers with `[[key, value], ...]`; older servers answer with a
   * flat `[key, value, key, value, ...]`. Both are accepted so a version bump
   * cannot turn this into a silently-empty record — which, for any caller that
   * fingerprints an instance from it, would turn an identity check into a
   * no-op.
   */
  async configSnapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const r = await this.client.raw<unknown[]>(["GRAPH.CONFIG", "GET", "*"]);
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

  /** Drops the client's graph key. Tolerates the key not existing. */
  async dropGraph(): Promise<void> {
    await this.client.dropGraph();
  }

  /** Escape hatch for server commands the typed client does not model. */
  async raw<T = unknown>(args: string[]): Promise<T> {
    return this.client.raw<T>(args);
  }
}
