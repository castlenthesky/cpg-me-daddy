// makeDelta, sinkError, classifyFailure and assertDeltaWellFormed, from the C-SINK text.

import type { GraphDelta, WorkspacePath } from '@cpg/model';
import { isWorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { assertDeltaWellFormed, classifyFailure, makeDelta, sinkError } from './delta';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}

const parts = (over: Partial<GraphDelta> = {}): GraphDelta => ({
  seq: 3,
  file: wp('a.py'),
  revision_id: 'r',
  producer: 'code',
  addedNodes: [],
  addedEdges: [],
  removedNodeIds: [],
  ...over,
});

const thrown = (fn: () => void): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('makeDelta', () => {
  it('returns undefined when nothing changed (INV-3)', () => {
    expect(makeDelta(parts())).toBeUndefined();
  });

  it.each([
    ['nodes', { addedNodes: [{ id: 'n', type: 'METHOD' }] }],
    ['edges only (INV-4)', { addedEdges: [{ source: 'a', target: 'b', type: 'CALLS' }] }],
    ['removals only', { removedNodeIds: ['n'] }],
  ])('returns the delta unchanged when it carries %s', (_label, over) => {
    const input = parts(over);
    expect(makeDelta(input)).toEqual(input);
  });
});

describe('sinkError and classifyFailure', () => {
  it('builds an Error named SinkError carrying kind, sinkId, seq and the extras', () => {
    const cause = new Error('socket');
    const e = sinkError('overloaded', 'memory', 7, 'queue full', { retryAfterMs: 50, cause });
    expect(e).toBeInstanceOf(Error);
    const { name, message, kind, sinkId, seq, retryAfterMs } = e;
    expect({ name, message, kind, sinkId, seq, retryAfterMs, cause: e.cause }).toEqual({
      name: 'SinkError',
      message: 'queue full',
      kind: 'overloaded',
      sinkId: 'memory',
      seq: 7,
      retryAfterMs: 50,
      cause,
    });
  });

  it.each(['transient', 'overloaded', 'out-of-order', 'malformed', 'permanent'] as const)(
    'classifies a SinkError of kind %s as itself',
    (kind) => {
      expect(classifyFailure(sinkError(kind, 's', 0, 'm'))).toBe(kind);
    },
  );

  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['a SinkError look-alike with an unknown kind', { name: 'SinkError', kind: 'exploded' }],
    ['an object without the SinkError name', { kind: 'permanent' }],
  ])('classifies %s as transient (INV-13)', (_label, value) => {
    expect(classifyFailure(value)).toBe('transient');
  });
});

describe('assertDeltaWellFormed (INV-18)', () => {
  const prior = new Set(['a', 'b']);

  it('accepts edges onto prior nodes and onto nodes the same delta adds', () => {
    const d = parts({
      addedNodes: [{ id: 'c', type: 'METHOD' }],
      addedEdges: [
        { source: 'a', target: 'b', type: 'CALLS' },
        { source: 'c', target: 'a', type: 'CALLS' },
      ],
    });
    expect(thrown(() => assertDeltaWellFormed(d, prior, 'memory', 3))).toBeUndefined();
  });

  it('applies removals before additions: an edge onto a removed-and-re-added node is live', () => {
    const d = parts({
      removedNodeIds: ['b'],
      addedNodes: [{ id: 'b', type: 'METHOD' }],
      addedEdges: [{ source: 'a', target: 'b', type: 'CALLS' }],
    });
    expect(thrown(() => assertDeltaWellFormed(d, prior, 'memory', 3))).toBeUndefined();
  });

  it.each([
    ['a missing target', { addedEdges: [{ source: 'a', target: 'z', type: 'CALLS' }] }],
    ['a missing source', { addedEdges: [{ source: 'z', target: 'a', type: 'CALLS' }] }],
    [
      'an endpoint the same delta removes',
      { removedNodeIds: ['b'], addedEdges: [{ source: 'a', target: 'b', type: 'CALLS' }] },
    ],
  ])('throws a malformed SinkError for %s', (_label, over) => {
    const error = thrown(() => assertDeltaWellFormed(parts(over), prior, 'memory', 3));
    expect(classifyFailure(error)).toBe('malformed');
    expect(error).toMatchObject({ sinkId: 'memory', seq: 3 });
  });
});
