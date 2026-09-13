import { nodeSpec } from "../schema/schema";
import type { EdgeRow, GraphDelta, NodeRow } from "../schema/validate";
/**
 * Bridges the filesystem tier into a per-file extraction delta: appends a
 * FILE node row (merge-on-key, idempotent against the later filesystem-tier
 * batch `writeFilesystem` runs) and one `SOURCE_FILE` edge from the delta's
 * MODULE root to it. This is the fix for the graph's two disconnected
 * components — previously the only join between `FILE` and `:CPG` nodes was
 * the string equality `MODULE.file == FILE.path`.
 *
 * Emitted here, not inside `extractDeclarations` — the extractor has no
 * access to `content_hash`/`loc`/`indexed_at`, and `index-workspace.ts`
 * already computes an `FsFileRow` for the current file once, immediately
 * before extraction, for exactly that reason.
 */
import type { FsFileRow } from "../store/cypher";

export interface AttachSourceFileResult {
  readonly delta: GraphDelta;
  /** `false` when `delta` had no MODULE root to bridge — the caller should warn, not throw. */
  readonly attached: boolean;
}

function fileNodeRow(fileRow: FsFileRow): NodeRow {
  const spec = nodeSpec("FILE");
  if (spec === undefined) {
    throw new Error("attachSourceFile: 'FILE' is not a declared v1 schema label.");
  }
  return {
    labels: spec.cpgCoLabel ? ["CPG", "FILE"] : ["FILE"],
    properties: {
      path: fileRow.path,
      name: fileRow.name,
      language: fileRow.language,
      content_hash: fileRow.content_hash,
      status: fileRow.status,
      version: fileRow.version,
      indexed_at: fileRow.indexed_at,
      loc: fileRow.loc,
    },
  };
}

/**
 * Appends `fileRow`'s FILE node and a `SOURCE_FILE` edge from `delta`'s
 * MODULE node to it. A no-op (`attached: false`) if `delta` carries no
 * MODULE node — every adapter shipped today always emits exactly one, so
 * this is a defensive branch for a future non-conforming adapter, not a
 * reachable case in this pipeline.
 */
export function attachSourceFile(delta: GraphDelta, fileRow: FsFileRow): AttachSourceFileResult {
  const moduleNode = delta.nodes.find((n) => n.labels.includes("MODULE"));
  const moduleId = moduleNode?.properties["id"];
  if (typeof moduleId !== "string") {
    return { delta, attached: false };
  }

  const sourceFileEdge: EdgeRow = {
    type: "SOURCE_FILE",
    fromLabel: "MODULE",
    toLabel: "FILE",
    fromKey: moduleId,
    toKey: fileRow.path,
    properties: {},
  };

  return {
    delta: {
      ...delta,
      nodes: [...delta.nodes, fileNodeRow(fileRow)],
      edges: [...delta.edges, sourceFileEdge],
    },
    attached: true,
  };
}
