// Tooltip text (BMO-35 line 2, "tooltip controller"). Formats from the archive's showTooltip and
// showLinkTooltip (21754b4:packages/graph-visualizer/src/visualizer.ts:702-704, :746-750):
// `TYPE: name`, `Relationship label: source → target`, plus ` — status (reason)` when the node or
// edge carries a well-formed `data.resolution` (read through @cpg/model's readers).

import type { GraphEdge, GraphNode } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { linkTooltipText, nodeTooltipText } from './tooltip';

const resolution = (status: string, reason?: string): Record<string, unknown> =>
  reason === undefined
    ? { resolution: { status, resolvedBy: 'null-resolver' } }
    : { resolution: { status, resolvedBy: 'null-resolver', reason } };

const call = (data?: Record<string, unknown>): GraphNode =>
  data === undefined
    ? { id: 'c1', type: 'CALL', name: 'foo' }
    : { id: 'c1', type: 'CALL', name: 'foo', data };

describe('nodeTooltipText', () => {
  it('reads TYPE: name', () => {
    expect(nodeTooltipText({ id: 'src/a.ts', type: 'FILE', name: 'a.ts' })).toBe('FILE: a.ts');
  });

  it('falls back to the id when the node has no name', () => {
    expect(nodeTooltipText({ id: 'src/a.ts', type: 'FILE' })).toBe('FILE: src/a.ts');
  });

  it('appends the resolution status and reason', () => {
    expect(nodeTooltipText(call(resolution('unresolved', 'no resolver')))).toBe(
      'CALL: foo — unresolved (no resolver)',
    );
  });

  it('appends the status alone when there is no reason, or an empty one', () => {
    expect(nodeTooltipText(call(resolution('resolved')))).toBe('CALL: foo — resolved');
    expect(nodeTooltipText(call(resolution('external', '')))).toBe('CALL: foo — external');
  });

  it('appends nothing for a missing or malformed resolution', () => {
    expect(nodeTooltipText(call())).toBe('CALL: foo');
    // No resolvedBy: malformed under readNodeResolution, so no suffix.
    expect(nodeTooltipText(call({ resolution: { status: 'resolved' } }))).toBe('CALL: foo');
    expect(nodeTooltipText(call({ resolution: 'resolved' }))).toBe('CALL: foo');
  });
});

describe('linkTooltipText', () => {
  const a: GraphNode = { id: 'src/a.ts', type: 'FILE', name: 'a.ts' };
  const b: GraphNode = { id: 'src/b.ts', type: 'FILE', name: 'b.ts' };
  const imports: GraphEdge = { source: 'src/a.ts', target: 'src/b.ts', type: 'IMPORTS' };

  it('reads Label: source → target with the registry label and the endpoint names', () => {
    expect(linkTooltipText(imports, a, b)).toBe('Imports: a.ts → b.ts');
  });

  it('falls back to the endpoint ids for an unknown or unnamed endpoint', () => {
    expect(linkTooltipText(imports, undefined, { id: 'src/b.ts', type: 'FILE' })).toBe(
      'Imports: src/a.ts → src/b.ts',
    );
  });

  it('labels an untyped edge Untyped and an unregistered type by its raw string', () => {
    expect(linkTooltipText({ source: a.id, target: b.id }, a, b)).toBe('Untyped: a.ts → b.ts');
    expect(linkTooltipText({ source: a.id, target: b.id, type: 'REF' }, a, b)).toBe(
      'REF: a.ts → b.ts',
    );
  });

  it("appends the edge's own resolution, not an endpoint's", () => {
    const resolvedEdge: GraphEdge = { ...imports, data: resolution('ambiguous', '2 candidates') };
    expect(linkTooltipText(resolvedEdge, a, b)).toBe(
      'Imports: a.ts → b.ts — ambiguous (2 candidates)',
    );
    const resolvedSource: GraphNode = { ...a, data: resolution('resolved') };
    expect(linkTooltipText(imports, resolvedSource, b)).toBe('Imports: a.ts → b.ts');
  });

  // round two (review a7): the edge's resolution goes through readEdgeResolution as well.
  it('formats an edge resolution like a node one: no reason, an empty reason, or malformed', () => {
    expect(linkTooltipText({ ...imports, data: resolution('resolved') }, a, b)).toBe(
      'Imports: a.ts → b.ts — resolved',
    );
    expect(linkTooltipText({ ...imports, data: resolution('external', '') }, a, b)).toBe(
      'Imports: a.ts → b.ts — external',
    );
    const noResolver: GraphEdge = { ...imports, data: { resolution: { status: 'resolved' } } };
    expect(linkTooltipText(noResolver, a, b)).toBe('Imports: a.ts → b.ts');
  });
});
