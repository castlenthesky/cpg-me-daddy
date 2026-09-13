/**
 * M0.4b — `IGraphStore` backed by FalkorDB, executing `planDelta`'s ops via
 * `GraphService.write` in the order `planDelta` returns them (scope delete,
 * then nodes, then edges). Never imports `falkordb` directly (M0.4a's
 * `.oxlintrc.json` rule) or opens its own connection — the same
 * `BootstrapGraph`/`BootstrapAdmin` structural interfaces `bootstrap.ts`
 * uses, so a real `GraphService`/`AdminService` satisfy this store directly
 * and a DB-free unit test can pass a plain fake.
 */
import type { GraphDelta } from "../schema/validate";
import {
  bootstrapSchema,
  type BootstrapAdmin,
  type BootstrapGraph,
  type BootstrapReport,
} from "./bootstrap";
import { planDelta } from "./cypher";
import type { GraphMetadata, IGraphStore, WriteReport } from "./store";

export interface FalkorGraphStoreDeps {
  readonly graph: BootstrapGraph;
  readonly admin: BootstrapAdmin;
  /** Closes the underlying connection (and, if this store started one, the server). */
  readonly close: () => Promise<void>;
}

interface MetadataRow {
  readonly schema_version: number;
  readonly engine_version: string | null;
  readonly overlays: string[] | null;
}

export class FalkorGraphStore implements IGraphStore {
  constructor(private readonly deps: FalkorGraphStoreDeps) {}

  async bootstrap(): Promise<BootstrapReport> {
    return bootstrapSchema({ graph: this.deps.graph, admin: this.deps.admin });
  }

  async writeDelta(delta: GraphDelta): Promise<WriteReport> {
    const ops = planDelta(delta);
    for (const op of ops) {
      // Sequential and ordered by design: planDelta places the scope delete
      // before the nodes it clears the way for, and the nodes before the
      // edges that need them to already exist. Not yet one atomic
      // transaction — M1.2 owns collapsing this into a single chained
      // Cypher statement; see IGraphStore.writeDelta's own doc.
      // eslint-disable-next-line no-await-in-loop
      await this.deps.graph.write(op.cypher, op.params);
    }
    return {
      nodesWritten: delta.nodes.length,
      edgesWritten: delta.edges.length,
      opsExecuted: ops.length,
    };
  }

  async deleteFile(file: string): Promise<void> {
    await this.writeDelta({ file, nodes: [], edges: [] });
  }

  async readMetadata(): Promise<GraphMetadata | undefined> {
    const rows = await this.deps.graph.read<MetadataRow>(
      "MATCH (m:META_DATA) RETURN m.schema_version AS schema_version, " +
        "m.engine_version AS engine_version, m.overlays AS overlays LIMIT 1",
    );
    const row = rows.data[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      schemaVersion: row.schema_version,
      engineVersion: row.engine_version ?? undefined,
      overlays: row.overlays ?? [],
    };
  }

  async close(): Promise<void> {
    await this.deps.close();
  }
}
