import { assertType, describe, expect, expectTypeOf, it } from 'vitest';
import * as model from './index';
import {
  applyGraphDelta,
  readEdgeResolution,
  readNodeLocation,
  readNodeResolution,
  validatePayload,
  type EdgeResolution,
  type ModelDefect,
  type ModelDefectCode,
  type NodeLocation,
  type Read,
  type WorkspacePath,
  toWorkspacePath,
  type DeltaApplyResult,
  type GraphDelta,
  type GraphNode,
  type GraphPayload,
  type HostToWebview,
  type PropertyOwner,
  type PropertySpec,
  type WebviewToHost,
} from './index';
import { ownedBy } from './schema/owner';

declare const p: GraphPayload;
declare const d: GraphDelta;

describe('@cpg/model public types', () => {
  it('applyGraphDelta is payload x delta -> DeltaApplyResult', () => {
    expectTypeOf(applyGraphDelta).parameters.toEqualTypeOf<[GraphPayload, GraphDelta]>();
    expectTypeOf(applyGraphDelta).returns.toEqualTypeOf<DeltaApplyResult>();
  });

  it('DeltaApplyResult has exactly the four outcomes', () => {
    expectTypeOf<DeltaApplyResult['outcome']>().toEqualTypeOf<
      'applied' | 'already-applied' | 'gap' | 'malformed'
    >();
  });

  it('GraphDelta.producer is PropertyOwner, and seq is a number', () => {
    expectTypeOf<GraphDelta['producer']>().toEqualTypeOf<PropertyOwner>();
    expectTypeOf<PropertyOwner>().toEqualTypeOf<'filesystem' | 'code'>();
    expectTypeOf<GraphDelta['seq']>().toEqualTypeOf<number>();
    expectTypeOf<GraphPayload['seq']>().toEqualTypeOf<number>();
  });

  it('narrowing on gap exposes expected/got and no payload', () => {
    const r = applyGraphDelta(p, d);
    if (r.outcome === 'gap') {
      expectTypeOf(r.expected).toEqualTypeOf<number>();
      expectTypeOf(r.got).toEqualTypeOf<number>();
      // @ts-expect-error a gap carries no payload
      void r.payload;
    }
    if (r.outcome === 'applied') {
      expectTypeOf(r.payload).toEqualTypeOf<GraphPayload>();
    }
  });

  it('GraphDelta is the F-1 envelope: no removedEdgeIds, no revision, seq required', () => {
    const ok = {
      seq: 0,
      file: toWorkspacePath('/w', '/w/a.ts'),
      revision_id: 'r',
      producer: 'code',
      addedNodes: [],
      addedEdges: [],
      removedNodeIds: [],
    } as const satisfies GraphDelta;
    assertType<GraphDelta>(ok);
    // @ts-expect-error removedEdgeIds does not exist (edges are implied by removedNodeIds)
    assertType<GraphDelta>({ ...ok, removedEdgeIds: [] });
    // @ts-expect-error baseRevision does not exist
    assertType<GraphDelta>({ ...ok, baseRevision: 1 });
    // seq is required: omitting it entirely must not typecheck
    const { seq: _s, ...noSeq } = ok;
    // @ts-expect-error seq is missing
    assertType<GraphDelta>(noSeq);
    // @ts-expect-error seq may not be undefined
    assertType<GraphDelta>({ ...ok, seq: undefined });
    // @ts-expect-error producer is only 'filesystem' | 'code'
    assertType<GraphDelta>({ ...ok, producer: 'engine' });
  });

  it('composeDeltas and edgeId do not exist (acceptance: absent from the public API)', () => {
    expect('composeDeltas' in model).toBe(false);
    expect('edgeId' in model).toBe(false);
  });

  it('the payload and delta arrays are readonly (I-11)', () => {
    expectTypeOf(p.nodes).toEqualTypeOf<readonly GraphNode[]>();
    // @ts-expect-error readonly array has no push
    p.nodes.push({ id: 'a', type: 'x' });
    // @ts-expect-error seq is readonly
    p.seq = 1;
  });

  it('ownedBy forbids an inline owner and returns owned PropertySpecs', () => {
    const prop = {
      name: 'p',
      type: 'string',
      cardinality: 'one',
      golden: 'include',
      doc: '',
    } as const;
    expectTypeOf(ownedBy('code', [prop])).toEqualTypeOf<readonly PropertySpec[]>();
    // @ts-expect-error an inline owner would defeat per-group declaration
    ownedBy('code', [{ ...prop, owner: 'filesystem' }]);
  });

  it('GraphNode.type stays an open string (renderers must not switch exhaustively)', () => {
    expectTypeOf<GraphNode['type']>().toEqualTypeOf<string>();
  });

  it('ModelDefectCode is exactly the seven contract codes', () => {
    expectTypeOf<ModelDefectCode>().toEqualTypeOf<
      | 'empty-id'
      | 'id-contains-separator'
      | 'duplicate-node-id'
      | 'dangling-edge'
      | 'malformed-location'
      | 'malformed-resolution'
      | 'non-monotonic-seq'
    >();
  });

  it('the read accessors return Read<T>', () => {
    expectTypeOf(readNodeLocation).returns.toEqualTypeOf<Read<NodeLocation>>();
    expectTypeOf(readNodeResolution).returns.toEqualTypeOf<Read<EdgeResolution>>();
    expectTypeOf(readEdgeResolution).returns.toEqualTypeOf<Read<EdgeResolution>>();
  });

  it('Read<T> narrows on state: present has value, malformed has defect, absent has neither', () => {
    const r = readNodeLocation({ id: 'a', type: 'X' });
    expectTypeOf(r).toEqualTypeOf<Read<NodeLocation>>();
    // @ts-expect-error value exists only after narrowing to present
    void r.value;
    if (r.state === 'present') expectTypeOf(r.value).toEqualTypeOf<NodeLocation>();
    if (r.state === 'malformed') expectTypeOf(r.defect).toEqualTypeOf<ModelDefect>();
    if (r.state === 'absent') {
      // @ts-expect-error absent carries no value
      void r.value;
    }
  });

  it('NodeLocation.filePath is a WorkspacePath and its fields are readonly', () => {
    expectTypeOf<NodeLocation['filePath']>().toEqualTypeOf<WorkspacePath>();
    const range = { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 };
    // @ts-expect-error a plain string is not a WorkspacePath
    const bad: NodeLocation = { filePath: 'src/x.ts', range };
    void bad;
    const loc: NodeLocation = { filePath: toWorkspacePath('/w', '/w/x.ts'), range };
    // @ts-expect-error NodeLocation is readonly
    loc.range = range;
  });

  it('validatePayload takes one or two args and returns a readonly ModelDefect array', () => {
    expectTypeOf(validatePayload).parameter(0).toEqualTypeOf<GraphPayload>();
    expectTypeOf(validatePayload).returns.toEqualTypeOf<readonly ModelDefect[]>();
    assertType(validatePayload(p));
    assertType(validatePayload(p, { previousSeq: 3 }));
    // @ts-expect-error previousSeq is a number
    validatePayload(p, { previousSeq: '3' });
  });

  /* oxlint-disable import/namespace -- the point is to touch names that must not exist. */
  it('the old accessors are gone from the module', () => {
    // @ts-expect-error replaced by readNodeLocation
    void model.nodeLocation;
    // @ts-expect-error replaced by readNodeResolution
    void model.nodeResolution;
    // @ts-expect-error replaced by readEdgeResolution
    void model.edgeResolution;
    expectTypeOf(model).not.toHaveProperty('nodeLocation');
  });
  /* oxlint-enable import/namespace */

  it('the message unions discriminate on `type`', () => {
    expectTypeOf<HostToWebview['type']>().toEqualTypeOf<'graph' | 'graph-delta'>();
    expectTypeOf<WebviewToHost['type']>().toEqualTypeOf<'ready' | 'reveal'>();
    // @ts-expect-error reveal must carry a nodeId
    assertType<WebviewToHost>({ type: 'reveal' });
  });
});
