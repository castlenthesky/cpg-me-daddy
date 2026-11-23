// @cpg/model — the graph vocabulary.
//
// PROVENANCE: ported essentially verbatim from
//   archive/discovery-20260916:packages/graph-visualizer/src/contract.ts
// where it lived *inside the renderer package*. Four consumers deep-imported
// `@cpg/graph-visualizer/dist/contract` to reach it, each carrying its own
// paragraph explaining why, and a later `dist/layout` deep import violated the
// rule silently. Four copies of the same rationale meant the fix belonged in
// the dependency graph, not in a comment — so the vocabulary now owns a package
// and everyone depends on it, rather than on whoever happened to declare it.
//
// No imports from outside this package, enforced by `tools/check-deps.mjs`. This file
// is required (or type-imported) from both a CommonJS/Node context (the CLI,
// the extension host) and a browser/ESM context (the webview) — pulling in
// anything here would pull that dependency's runtime into whichever side merely
// wants the types.

import type { WorkspacePath } from './paths';
import type { PropertyOwner } from './schema';

/**
 * A range in a source file, in exactly the coordinate system
 * `vscode.Position` uses: zero-based rows, and columns counted in UTF-16 code
 * units (not bytes, and not codepoints).
 *
 * That match is not a coincidence worth relying on silently: tree-sitter's
 * core counts columns in bytes, but its web binding feeds the source in as
 * UTF-16 and converts the offsets back on the way out, so what the parser
 * reports is already UTF-16 code units. A range therefore travels from the
 * parser to `new vscode.Position(row, column)` with no conversion, and a line
 * containing an emoji or an accented character can't shift the cursor.
 * Verified empirically rather than assumed — if the parser is ever swapped for
 * one reporting byte columns, this is the type whose contract breaks, and
 * every consumer below inherits the bug.
 */
export interface SourceRange {
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
}

/**
 * Everything a host needs to open a node's source and put the cursor on it —
 * carried in `GraphNode.data.location` and read back through `readNodeLocation`.
 *
 * `range` is the construct's full extent (the whole method, the whole class)
 * and is what to frame in the viewport. `nameRange` is the construct's
 * identifier token — `foo` in `function foo()`, the callee chain in a call —
 * and is where the cursor actually belongs: a method's `range` starts on the
 * `function` keyword, so revealing by `range` alone lands the caret one token
 * short of what the user clicked. It's optional because not every construct
 * has a name-shaped child (an import statement, an anonymous arrow function),
 * in which case `range` is the only sensible target.
 */
export interface NodeLocation {
  /** The owning file, workspace-relative (DQ-02). Never `'.'`: the root is not a source file. */
  readonly filePath: WorkspacePath;
  readonly range: SourceRange;
  readonly nameRange?: SourceRange;
}

/**
 * A single graph node. `type` drives both the point colour and the legend
 * grouping — today `'file' | 'directory'`, but nothing here constrains it:
 * CPG labels (`METHOD`, `TYPE_DECL`, `CALL`, …) arrive as more producers come
 * online. Renderers must derive-and-fallback on an unknown `type` rather than
 * switch exhaustively, so adding a label is not a cross-package edit.
 */
export interface GraphNode {
  /** Unique across the whole payload. A file path today. */
  readonly id: string;
  readonly type: string;
  /**
   * Short display name — the basename for files/directories, never a full
   * path (that's `id`). Falls back to `id` if omitted.
   */
  readonly name?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * A single graph edge. `type` is optional free-form metadata (`'AST'`,
 * `'CFG'`, `'REACHING_DEF'`, …); edges of the visualizer's configured
 * hierarchy edge type additionally seed the radial layout.
 */
export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly type?: string;
  /**
   * Open property bag, same contract as `GraphNode.data` — read back through a
   * typed accessor (`readEdgeResolution`) rather than by indexing, so only one
   * place knows each key's shape.
   *
   * Nothing in the renderer reads it, and that is not an oversight: the link
   * buffers are flat `Float32Array`s of endpoint indices, so there is no
   * per-link slot for a property to occupy, and link colour is derived from
   * the two endpoints rather than set per link. So this is a home for
   * provenance a *producer* needs to keep and a *host* may want to surface —
   * not a rendering channel.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * How confident a cross-reference edge is, and who decided.
 *
 * `status` mirrors the shared five-value resolution enum carried on
 * `CALLS`/`IMPORTS`: resolved | ambiguous | external | unresolved | dynamic.
 * It is a string rather than a union here so that a producer emitting a value
 * this package has not heard of degrades to "unknown status" instead of
 * failing to typecheck across a package boundary.
 */
export interface EdgeResolution {
  readonly status: string;
  /** The resolver id that produced this answer, so provenance is inspectable per edge rather than per run. */
  readonly resolvedBy: string;
  /** In [0, 1], as C-RESOLVE defines it. */
  readonly confidence?: number;
  readonly reason?: string;
}

/**
 * A full snapshot. `seq` is the seq of the last delta folded in; a payload that has applied nothing
 * has seq -1 (the same as a fresh `SinkState.highWaterSeq`).
 */
export interface GraphPayload {
  readonly seq: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/**
 * The F-1 envelope: the minimal add/remove that brings a `GraphPayload` at `seq - 1` up to `seq`,
 * instead of resending the whole workspace on every change.
 *
 * Removed edges are never listed explicitly — `removedNodeIds` implies them, since an edge touching
 * a removed node can't meaningfully remain (`applyGraphDelta` drops such edges).
 *
 * Re-adding an id that is already present MERGES in place, by per-property owner: the `producer`
 * tier's keys are replaced and the other tier's keys are kept (DQ-01c). That is how a FILE carries
 * both the walker's `content_hash` and the code tier's `interface_hash` without the historical
 * duplicate-node bug (L-01). A same-tier re-add of a delete-create label without removing it first
 * is malformed; remove-then-add is the whole-replace form.
 */
export interface GraphDelta {
  /** Per-workspace, allocated by SINK (F-1). */
  readonly seq: number;
  /** The owning file. */
  readonly file: WorkspacePath;
  /** The owning file's content hash; also on each added node (not checked by `applyGraphDelta`). */
  readonly revision_id: string;
  /** The tier that produced this delta: the discriminant of the owner merge. */
  readonly producer: PropertyOwner;
  readonly addedNodes: readonly GraphNode[];
  readonly addedEdges: readonly GraphEdge[];
  readonly removedNodeIds: readonly string[];
}

/** The webview protocol's version (C-EXT): every host message carries it, and `ready` reports the page's. */
export const CPG_PROTOCOL_VERSION = 1 as const;

/** Engine-assigned ordering number of a payload or delta (F-1). */
export type Seq = number;
/** Host-assigned; bumps on every full (`cause: 'initial'`) snapshot (C-EXT I-13). */
export type Epoch = number;

/** The shared verify check ids (05-contracts.yaml shared.verify_check_ids), in enum order. */
export type VerifyCheckId =
  | 'filesystem-reconciliation'
  | 'identity-invariants'
  | 'id-uniqueness'
  | 'render-reconciliation'
  | 'revision-reconciliation'
  | 'resolution-health';

/** Worst-of ordering: fail > stale > unavailable > pass. */
export type CheckState = 'pass' | 'fail' | 'stale' | 'unavailable';

/** One verify check's result: C-CLI's VerifyReport and C-EXT's VerificationReport share it. */
export interface CheckResult {
  readonly id: VerifyCheckId;
  readonly state: CheckState;
  readonly observed: number;
  readonly expected: number;
  /** The offending workspace paths (directories or files) or keys, sorted. */
  readonly localisedTo: readonly string[];
  readonly detail?: string;
  /** The graph's seq, snapshotted before the check's first await. */
  readonly asOfSeq: number;
}

/** The verdict shown beside the graph (C-EXT; 08-verification §3.3). */
export interface VerificationReport {
  readonly epoch: Epoch;
  readonly seq: Seq;
  /** All six, once each, in enum order (C-EXT I-18). */
  readonly checks: readonly CheckResult[];
  /** The worst state of `checks`. */
  readonly state: CheckState;
}

/** The host's theme (C-EXT). The browser inspector does not send one yet (controller decision 14). */
export interface ThemeSnapshot {
  readonly kind: 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';
  readonly nodeColors: Readonly<Record<string, string>>;
  readonly defaultNodeColor: string;
}

/** What the renderer drew, for render-reconciliation (C-EXT I-10, owner decision 12a). */
export interface RenderReport {
  /** `payload.nodes.length`, duplicate ids included. */
  readonly payloadNodeCount: number;
  /** Distinct payload node ids drawn as a point. */
  readonly renderedNodeCount: number;
  /** Distinct (source, target, type) edges drawn. */
  readonly renderedEdgeCount: number;
  /** Payload edges that repeat an earlier edge's (source, target, type), so draw once (12a). */
  readonly duplicateEdges: number;
  /** A capped sample of the ids with a payload entry left undrawn. */
  readonly droppedNodeIds: readonly string[];
  readonly frameMs: number;
}

/** Host → webview (C-EXT HostToWebviewMessage). */
export type HostToWebview =
  | {
      readonly type: 'theme';
      readonly protocol: typeof CPG_PROTOCOL_VERSION;
      readonly epoch: Epoch;
      readonly theme: ThemeSnapshot;
    }
  | {
      readonly type: 'graph';
      readonly protocol: typeof CPG_PROTOCOL_VERSION;
      readonly epoch: Epoch;
      readonly seq: Seq;
      readonly payload: GraphPayload;
    }
  | {
      readonly type: 'graph-delta';
      readonly protocol: typeof CPG_PROTOCOL_VERSION;
      readonly epoch: Epoch;
      readonly seq: Seq;
      readonly delta: GraphDelta;
    }
  | {
      readonly type: 'verification';
      readonly protocol: typeof CPG_PROTOCOL_VERSION;
      readonly epoch: Epoch;
      readonly seq: Seq;
      readonly report: VerificationReport;
    };

/**
 * Webview → host (C-EXT WebviewToHostMessage).
 *
 * `reveal` carries only the node id, never the location itself: the host
 * already holds the authoritative merged payload and resolves the id against
 * it, so there is one source of truth for where a node points and no way for a
 * stale view to ask the host to open a range that no longer exists.
 */
export type WebviewToHost =
  | { readonly type: 'ready'; readonly protocol: number }
  | { readonly type: 'reveal'; readonly nodeId: string }
  | {
      readonly type: 'resync';
      readonly epoch: Epoch;
      readonly seq: Seq;
      readonly reason: 'gap' | 'stale-epoch' | 'render-error';
    }
  | {
      readonly type: 'render-report';
      readonly epoch: Epoch;
      readonly seq: Seq;
      readonly report: RenderReport;
    };

export * from './delta';
export * from './read';
export * from './payload';
export * from './schema';
export * from './paths';
export * from './digest';
