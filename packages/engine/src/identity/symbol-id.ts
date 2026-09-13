/**
 * `SYMBOL.fqn` grammar (M0.7/M0.9): an fqn and a node id are two renderings
 * of the same lexical scope chain (`ScopeSegment[]` from `./node-id.ts`).
 * Adapted from SCIP's descriptor grammar (`research/R2-symbol-resolution-
 * and-scip.md` §158(b)) with one deliberate divergence, decided
 * 2026-09-13: an EXTERNAL symbol's owner carries its `scheme:package`
 * prefix INSIDE the fqn, not only as node properties. `SYMBOL.fqn` carries
 * a server-enforced `UNIQUE` constraint, and two packages both exporting
 * `Foo#bar().` would otherwise collide onto one node. A WORKSPACE-local
 * symbol doesn't need that prefix — its owning path is already unique — and
 * stays canonical SCIP: `` `path`/descriptors ``.
 *
 * Descriptor suffixes, straight from SCIP: `name/` (namespace), `name#`
 * (type), `name.` (term — a variable/constant/field), `name().` (method or
 * free function).
 */
import type { ScopeSegment } from "./node-id";

export type SymbolSegmentKind = "namespace" | "type" | "term" | "method";

export interface SymbolSegment {
  readonly kind: SymbolSegmentKind;
  readonly name: string;
}

const SEGMENT_SUFFIX: Record<SymbolSegmentKind, string> = {
  namespace: "/",
  type: "#",
  term: ".",
  method: "().",
};

/** Renders a chain of descriptor segments: `name<suffix>` concatenated, outermost first. */
export function descriptorPath(segments: readonly SymbolSegment[]): string {
  return segments.map((segment) => `${segment.name}${SEGMENT_SUFFIX[segment.kind]}`).join("");
}

/** A walker scope-frame kind's SCIP descriptor kind — `undefined` for a kind with no SYMBOL of its own. */
const SCOPE_KIND_TO_SEGMENT_KIND: Readonly<Record<string, SymbolSegmentKind>> = {
  TYPE_DECL: "type",
  METHOD: "method",
  MEMBER: "term",
};

/**
 * Maps a walker's `ScopeSegment` chain onto SCIP descriptor segments.
 * MODULE is dropped — it is the fqn's owner (the workspace path), never a
 * descriptor segment of its own. Throws on a scope kind with no SYMBOL
 * mapping (e.g. `CALL`, `PARAM`): callers only invoke this for the three
 * declaration kinds that mint a SYMBOL (MEMBER, METHOD, TYPE_DECL).
 */
export function descriptorsForScope(scope: readonly ScopeSegment[]): readonly SymbolSegment[] {
  return scope
    .filter((frame) => frame.kind !== "MODULE")
    .map((frame) => {
      const kind = SCOPE_KIND_TO_SEGMENT_KIND[frame.kind];
      if (kind === undefined) {
        throw new Error(
          `descriptorsForScope: scope kind '${frame.kind}' has no SCIP descriptor mapping.`,
        );
      }
      return { kind, name: frame.name };
    });
}

/**
 * A workspace-local owner prefix: the file's own path, backtick-escaped and
 * slash-terminated — canonical SCIP for a symbol whose identity is already
 * unique by virtue of living at one path. e.g. `hello_world.ts` ->
 * `` `hello_world.ts`/ ``.
 */
export function localOwner(path: string): string {
  return `\`${path}\`/`;
}

/**
 * An external package's owner prefix, e.g. `externalOwner("site", "node")`
 * -> `` site:node` ``. Baked into the fqn itself (see module doc) rather
 * than left to the `scheme`/`package` node properties alone.
 */
export function externalOwner(scheme: string, pkg: string): string {
  return `${scheme}:${pkg}\``;
}

/** `<owner><descriptors>` — the complete `SYMBOL.fqn`. */
export function makeSymbolFqn(owner: string, segments: readonly SymbolSegment[]): string {
  return `${owner}${descriptorPath(segments)}`;
}
