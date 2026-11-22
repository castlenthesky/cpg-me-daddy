import { describe, expectTypeOf, it } from 'vitest';
import type { WorkspacePath } from '../paths';
import { makeNodeId, parseNodeId, type NodeIdParts } from './ids';

declare const path: WorkspacePath;
declare const p: NodeIdParts;
type Arg = Parameters<typeof makeNodeId>[0];

describe('node id types (U1.1.3)', () => {
  it('makeNodeId returns string; parseNodeId returns NodeIdParts | undefined', () => {
    expectTypeOf(makeNodeId).returns.toEqualTypeOf<string>();
    expectTypeOf(parseNodeId).returns.toEqualTypeOf<NodeIdParts | undefined>();
  });

  it('a plain string is not a path', () => {
    expectTypeOf<Arg>().toEqualTypeOf<NodeIdParts>();
    // @ts-expect-error path must be a WorkspacePath
    makeNodeId({ form: 'file', path: 'a.ts' });
  });

  it('scope must be non-empty', () => {
    expectTypeOf(makeNodeId).toBeCallableWith({
      form: 'scoped',
      path,
      kind: 'METHOD',
      scope: ['f'],
    });
    // @ts-expect-error empty scope forbidden at compile time
    makeNodeId({ form: 'scoped', path, kind: 'METHOD', scope: [] });
  });

  it('ordinal and bodyHash are mutually exclusive', () => {
    expectTypeOf(makeNodeId).toBeCallableWith({
      form: 'scoped',
      path,
      kind: 'METHOD',
      scope: ['f'],
      ordinal: 1,
    });
    // @ts-expect-error cannot carry both
    makeNodeId({ form: 'scoped', path, kind: 'METHOD', scope: ['f'], ordinal: 1, bodyHash: 'ab' });
    makeNodeId({ form: 'scoped', path, kind: 'METHOD', scope: ['f'], ordinal: 1 });
    makeNodeId({ form: 'scoped', path, kind: 'METHOD', scope: ['f'], bodyHash: 'ab' });
  });

  it('form is the discriminant and narrows to the arm', () => {
    if (p.form === 'scoped') expectTypeOf(p.scope).toEqualTypeOf<readonly [string, ...string[]]>();
    else expectTypeOf(p).toMatchTypeOf<{ form: 'file' | 'directory'; path: WorkspacePath }>();
  });

  it('SYMBOL/TAG-like parts have no arm', () => {
    expectTypeOf(makeNodeId).toBeCallableWith({ form: 'directory', path });
    // @ts-expect-error not addressed by the rule
    makeNodeId({ form: 'symbol', fqn: 'x' });
  });
});
