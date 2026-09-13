/**
 * Node identity (M0.3): `path:kind:qualifiedScopePath[:ordinal|:bodyHash]`.
 *
 * Pinned by `../schema/schema.ts`'s `ID_RULE`, amended by R4 (40-research.yaml
 * AM1) to carry NO file content hash — a content hash would change every id
 * in a file on every save, defeating stable identity and breaking inbound
 * cross-file edges (that is the whole reason this module exists as its own
 * unit ahead of the extractor: get the rule right once, here, rather than
 * bake a wrong one into every adapter).
 *
 * `qualifiedScopePath` is the lexical ancestor chain's own NAMES, joined by
 * `/` — not a position. This is what makes ids stable across most edits and
 * is also why a rename cascades to a renamed container's descendants: their
 * ids are genuinely qualified by its name, the same tradeoff `SYMBOL.fqn`
 * makes deliberately for the same reason (GE-Q3: "a move cascades to
 * importers — they genuinely changed").
 *
 * Ranges are never part of this — PR1 (sparse by design): identity is for
 * addressing a thing, ranges are for navigating to it.
 *
 * Known limitation, kept unreachable by construction: `qualifiedScopePath`
 * joins frame NAMES only, not `(kind, name)` pairs, so a `TYPE_DECL "A"`
 * containing a `METHOD "b"` and a `METHOD "A"` containing a nested
 * `METHOD "b"` would produce the same id. `extract/walk.ts` now DOES
 * descend into a METHOD's own body (M0.7/M0.9, calls/data-flow), so a
 * METHOD is no longer always a leaf — but a nested NAMED function/class
 * declaration is a hard stop there for exactly this reason: it is what
 * keeps this collision unreachable rather than a coincidence of scope.
 * Revisit frame encoding (e.g. a kind-tagged join, SCIP-style) before any
 * unit lifts that barrier and adds real nested declarations/closures.
 */

/**
 * One frame of the lexical ancestor chain, outermost first, always ending
 * with the node's own frame. For everything except MODULE itself, MODULE is
 * never a frame here — a MODULE's descendants are addressed relative to it
 * via `path`, not via a repeated module-name segment.
 */
export interface ScopeSegment {
  /** The declaring node's own label, e.g. `"TYPE_DECL"`, `"METHOD"`. */
  readonly kind: string;
  /** The declaring node's own name segment. */
  readonly name: string;
}

export interface NodeIdInput {
  /** Workspace-relative file path. */
  readonly path: string;
  /** This node's own label — the node-label component of the id, not a frame. */
  readonly kind: string;
  /**
   * The lexical ancestor chain, outermost first, ending with this node's own
   * frame. MODULE's own chain is exactly one frame: `[{kind:"MODULE", name:
   * "<module name>"}]`. A top-level function's chain is exactly one frame
   * too: `[{kind:"METHOD", name:"greet"}]` — MODULE is not repeated, since it
   * is already the `path` component.
   */
  readonly scope: readonly ScopeSegment[];
  /**
   * Parent-scope-relative position — relative to the innermost enclosing
   * frame, not the file — so two identical anonymous items in different
   * methods never collide and inserting a sibling above one doesn't shift
   * it. Used only when this item has no stable name (or a duplicate name).
   */
  readonly ordinal?: number;
  /** Structural hash, for anonymous items an ordinal cannot stably address. */
  readonly bodyHash?: string;
}

/** Builds one node id per `ID_RULE`. */
export function makeNodeId(input: NodeIdInput): string {
  if (input.scope.length === 0) {
    throw new Error("makeNodeId: scope must have at least one frame (the node's own frame).");
  }
  const qualifiedScopePath = input.scope.map((frame) => frame.name).join("/");
  const suffix =
    input.bodyHash !== undefined
      ? `:${input.bodyHash}`
      : input.ordinal !== undefined
        ? `:${input.ordinal}`
        : "";
  return `${input.path}:${input.kind}:${qualifiedScopePath}${suffix}`;
}

/** Appends one frame to a scope chain — the walker's per-descent helper. */
export function extendScope(
  scope: readonly ScopeSegment[],
  frame: ScopeSegment,
): readonly ScopeSegment[] {
  return [...scope, frame];
}
