import { assertType, describe, expectTypeOf, it } from 'vitest';
import {
  applyGraphDelta,
  nodeLocation,
  type GraphDelta,
  type GraphNode,
  type GraphPayload,
  type HostToWebview,
  type WebviewToHost,
} from './index';

describe('@cpg/model public types', () => {
  it('applyGraphDelta is payload x delta -> payload', () => {
    expectTypeOf(applyGraphDelta).parameters.toEqualTypeOf<[GraphPayload, GraphDelta]>();
    expectTypeOf(applyGraphDelta).returns.toEqualTypeOf<GraphPayload>();
  });

  it('GraphNode.type stays an open string (renderers must not switch exhaustively)', () => {
    expectTypeOf<GraphNode['type']>().toEqualTypeOf<string>();
  });

  it('nodeLocation may return undefined', () => {
    expectTypeOf(nodeLocation).returns.toBeNullable();
  });

  it('the message unions discriminate on `type`', () => {
    expectTypeOf<HostToWebview['type']>().toEqualTypeOf<'graph' | 'graph-delta'>();
    expectTypeOf<WebviewToHost['type']>().toEqualTypeOf<'ready' | 'reveal'>();
    // @ts-expect-error reveal must carry a nodeId
    assertType<WebviewToHost>({ type: 'reveal' });
  });
});
