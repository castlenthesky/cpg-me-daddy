/**
 * A typed emitter over `NodeRow`/`EdgeRow`/`GraphDelta` (../schema/validate.ts) —
 * the shape M0.4's per-file writer will batch and `assertGraphDeltaValid()`
 * already gates. Adapters build a `GraphDelta` through this rather than
 * hand-assembling `labels: [...]` arrays, so the `:CPG` co-label always
 * agrees with what the schema declares for that label (`validate.ts`'s
 * co-label check exists precisely to catch the case this makes impossible to
 * get wrong by hand).
 */
import type { EdgeType } from "../schema/edges";
import type { NodeLabel } from "../schema/nodes";
import { nodeSpec } from "../schema/schema";
import type { EdgeRow, GraphDelta, NodeRow } from "../schema/validate";

export interface AddEdgeInput {
  readonly type: EdgeType;
  readonly fromLabel: string;
  readonly toLabel: string;
  /** The source node's own key (its `id`, or `fqn` for a SYMBOL endpoint). */
  readonly fromKey: string;
  /** The target node's own key. */
  readonly toKey: string;
  readonly properties?: Record<string, unknown>;
}

export class DeltaBuilder {
  private readonly nodeRows: NodeRow[] = [];
  private readonly edgeRows: EdgeRow[] = [];
  private readonly symbolRows: NodeRow[] = [];
  private readonly seenSymbolFqns = new Set<string>();

  constructor(private readonly file: string) {}

  /** Adds one node row, deriving `labels` from the label's own `cpgCoLabel` spec. */
  addNode(label: NodeLabel, properties: Record<string, unknown>): void {
    const spec = nodeSpec(label);
    if (spec === undefined) {
      throw new Error(`DeltaBuilder.addNode: '${label}' is not a declared v1 schema label.`);
    }
    const labels = spec.cpgCoLabel ? ["CPG", label] : [label];
    this.nodeRows.push({ labels, properties });
  }

  /**
   * Adds one SYMBOL row, deduped on `fqn` (two calls to the same external
   * function must mint exactly one SYMBOL) and held apart from `nodeRows`
   * so `build()` can place every SYMBOL after every `:CPG` node — the order
   * both golden fixtures use, and the order `checkGraphInvariants`' orphan
   * check depends on nothing but edges to satisfy anyway.
   */
  addSymbol(properties: Record<string, unknown>): void {
    const fqn = properties["fqn"];
    if (typeof fqn !== "string") {
      throw new Error("DeltaBuilder.addSymbol: 'fqn' must be a string.");
    }
    if (this.seenSymbolFqns.has(fqn)) {
      return;
    }
    this.seenSymbolFqns.add(fqn);
    this.symbolRows.push({ labels: ["SYMBOL"], properties });
  }

  /** Adds one edge row, with the real node keys it connects. */
  addEdge(input: AddEdgeInput): void {
    this.edgeRows.push({
      type: input.type,
      fromLabel: input.fromLabel,
      toLabel: input.toLabel,
      fromKey: input.fromKey,
      toKey: input.toKey,
      properties: input.properties ?? {},
    });
  }

  /** Freezes the accumulated rows into a `GraphDelta` ready for `assertGraphDeltaValid()`. */
  build(): GraphDelta {
    return {
      file: this.file,
      nodes: [...this.nodeRows, ...this.symbolRows],
      edges: [...this.edgeRows],
    };
  }
}
