import { describe, expectTypeOf, it } from 'vitest';
import type { EdgeType, ReservedEdgeSpec, ReservedEdgeType } from '../index';
import { RESERVED_EDGES } from '../index';

describe('reserved edge types (INV-RE-4)', () => {
  it('ReservedEdgeType is exactly EVAL_TYPE', () => {
    expectTypeOf<ReservedEdgeType>().toEqualTypeOf<'EVAL_TYPE'>();
  });

  it('EVAL_TYPE is not an admitted EdgeType', () => {
    expectTypeOf<'EVAL_TYPE'>().not.toExtend<EdgeType>();
    // @ts-expect-error reserved, not admitted
    const e: EdgeType = 'EVAL_TYPE';
    void e;
  });

  it('RESERVED_EDGES are ReservedEdgeSpecs', () => {
    expectTypeOf(RESERVED_EDGES).toExtend<readonly ReservedEdgeSpec[]>();
  });
});
