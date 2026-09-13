/**
 * M0.4b — the store seam. Deliberately narrow: `bootstrap`/`writeDelta`/
 * `deleteFile`/`readMetadata`/`close`, and no `read()`/`explain()` —
 * `FalkorService.graph` already IS the read surface (`GraphService.read`/
 * `scalar`/`explain`), and widening this interface to duplicate it is how it
 * stops being a seam. A caller that needs to read the graph reads it
 * directly; this interface is only for the write path a per-file replace
 * needs.
 */
import type { GraphDelta } from "../schema/validate";
import type { BootstrapReport } from "./bootstrap";

export interface WriteReport {
  readonly nodesWritten: number;
  readonly edgesWritten: number;
  readonly opsExecuted: number;
}

export interface GraphMetadata {
  readonly schemaVersion: number;
  readonly engineVersion: string | undefined;
  readonly overlays: readonly string[];
}

export interface IGraphStore {
  /** Creates the declared indexes/constraint and read-compares META_DATA (M0.4a). */
  bootstrap(): Promise<BootstrapReport>;
  /**
   * Writes one `GraphDelta` — the scope delete (if `delta.file` is set),
   * then its nodes, then its edges, each as its own query. Not yet wrapped
   * in a single atomic transaction; M1.2 upgrades this per-file replace
   * into one Cypher statement chained with `WITH count(*)` barriers.
   */
  writeDelta(delta: GraphDelta): Promise<WriteReport>;
  /** Deletes a file's `:CPG` subgraph with no replacement — the scope delete alone. */
  deleteFile(file: string): Promise<void>;
  /** The graph-wide `META_DATA` singleton, or `undefined` if bootstrap has never run. */
  readMetadata(): Promise<GraphMetadata | undefined>;
  close(): Promise<void>;
}
