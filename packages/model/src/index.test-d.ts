import { assertType, describe, expect, expectTypeOf, it } from 'vitest';
import * as model from './index';
import {
  applyGraphDelta,
  CPG_PROTOCOL_VERSION,
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
  type CheckResult,
  type CheckState,
  type Epoch,
  type HostToWebview,
  type PropertyOwner,
  type PropertySpec,
  type RenderReport,
  type Seq,
  type ThemeSnapshot,
  type VerificationReport,
  type VerifyCheckId,
  type WebviewToHost,
} from './index';
import { ownedBy } from './schema/owner';

declare const p: GraphPayload;
declare const d: GraphDelta;
const THEME: ThemeSnapshot = { kind: 'dark', nodeColors: {}, defaultNodeColor: 'x' };

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

  // Controller decision 13: the unions are C-EXT's HostToWebviewMessage / WebviewToHostMessage.
  it("the message unions are C-EXT's, discriminated on `type`", () => {
    expectTypeOf<HostToWebview['type']>().toEqualTypeOf<
      'theme' | 'graph' | 'graph-delta' | 'verification'
    >();
    expectTypeOf<WebviewToHost['type']>().toEqualTypeOf<
      'ready' | 'reveal' | 'resync' | 'render-report'
    >();
    expectTypeOf(CPG_PROTOCOL_VERSION).toEqualTypeOf<1>();
    expectTypeOf<HostToWebview['protocol']>().toEqualTypeOf<1>();
    expectTypeOf<HostToWebview['epoch']>().toEqualTypeOf<number>();
    expectTypeOf<Exclude<HostToWebview, { type: 'theme' }>['seq']>().toEqualTypeOf<number>();
    // @ts-expect-error reveal must carry a nodeId
    assertType<WebviewToHost>({ type: 'reveal' });
    // @ts-expect-error ready carries the page's protocol
    assertType<WebviewToHost>({ type: 'ready' });
    assertType<WebviewToHost>({ type: 'ready', protocol: 2 });
    // @ts-expect-error a graph message carries protocol, epoch and seq
    assertType<HostToWebview>({ type: 'graph', payload: p });
    assertType<HostToWebview>({ type: 'graph', protocol: 1, epoch: 1, seq: p.seq, payload: p });
    // @ts-expect-error the host speaks exactly protocol 1
    assertType<HostToWebview>({ type: 'graph', protocol: 2, epoch: 1, seq: p.seq, payload: p });
    assertType<HostToWebview>({ type: 'graph-delta', protocol: 1, epoch: 1, seq: d.seq, delta: d });
  });

  it('resync carries epoch, seq and one of three reasons', () => {
    expectTypeOf<Extract<WebviewToHost, { type: 'resync' }>['reason']>().toEqualTypeOf<
      'gap' | 'stale-epoch' | 'render-error'
    >();
    assertType<WebviewToHost>({ type: 'resync', epoch: 1, seq: 0, reason: 'gap' });
    // @ts-expect-error an unknown reason
    assertType<WebviewToHost>({ type: 'resync', epoch: 1, seq: 0, reason: 'bored' });
  });

  it("render-report carries C-EXT's counts plus duplicateEdges (owner decision 12a)", () => {
    expectTypeOf<RenderReport>().toEqualTypeOf<{
      readonly payloadNodeCount: number;
      readonly renderedNodeCount: number;
      readonly renderedEdgeCount: number;
      readonly duplicateEdges: number;
      readonly droppedNodeIds: readonly string[];
      readonly frameMs: number;
    }>();
    expectTypeOf<
      Extract<WebviewToHost, { type: 'render-report' }>['report']
    >().toEqualTypeOf<RenderReport>();
  });

  it('a verification message carries a VerificationReport of shared CheckResults', () => {
    expectTypeOf<
      Extract<HostToWebview, { type: 'verification' }>['report']
    >().toEqualTypeOf<VerificationReport>();
    expectTypeOf<VerificationReport['checks']>().toEqualTypeOf<readonly CheckResult[]>();
    expectTypeOf<VerificationReport['state']>().toEqualTypeOf<CheckState>();
    expectTypeOf<VerificationReport['epoch']>().toEqualTypeOf<number>();
    expectTypeOf<VerificationReport['seq']>().toEqualTypeOf<number>();
    expectTypeOf<CheckState>().toEqualTypeOf<'pass' | 'fail' | 'stale' | 'unavailable'>();
    expectTypeOf<VerifyCheckId>().toEqualTypeOf<
      | 'filesystem-reconciliation'
      | 'identity-invariants'
      | 'id-uniqueness'
      | 'render-reconciliation'
      | 'revision-reconciliation'
      | 'resolution-health'
    >();
    expectTypeOf<ThemeSnapshot['kind']>().toEqualTypeOf<
      'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark'
    >();
  });

  // Round two (review a12, b3): the theme branch has no seq; the remaining shapes are pinned.
  it('theme carries its snapshot and no seq; render-report and resync carry epoch and seq', () => {
    type Theme = Extract<HostToWebview, { type: 'theme' }>;
    expectTypeOf<Theme>().not.toHaveProperty('seq');
    expectTypeOf<Theme['theme']>().toEqualTypeOf<ThemeSnapshot>();
    expectTypeOf<ThemeSnapshot['nodeColors']>().toEqualTypeOf<Readonly<Record<string, string>>>();
    expectTypeOf<ThemeSnapshot['defaultNodeColor']>().toEqualTypeOf<string>();
    expectTypeOf<Seq>().toEqualTypeOf<number>();
    expectTypeOf<Epoch>().toEqualTypeOf<number>();
    type Report = Extract<WebviewToHost, { type: 'render-report' }>;
    expectTypeOf<Report['epoch']>().toEqualTypeOf<Epoch>();
    expectTypeOf<Report['seq']>().toEqualTypeOf<Seq>();
    expectTypeOf<Extract<WebviewToHost, { type: 'resync' }>['seq']>().toEqualTypeOf<Seq>();
    // @ts-expect-error a theme message carries no seq
    assertType<HostToWebview>({ type: 'theme', protocol: 1, epoch: 1, seq: 0, theme: THEME });
  });
});
